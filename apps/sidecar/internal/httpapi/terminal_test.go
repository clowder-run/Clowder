package httpapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"

	"github.com/psviderski/uncloud/api/pb"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
)

// openTerminal sends a terminal request for path with extra headers.
func openTerminal(t *testing.T, address, path, headers string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = io.WriteString(conn, "GET "+path+" HTTP/1.1\r\nHost: sidecar\r\nAuthorization: Bearer "+testAuthToken+"\r\n"+headers+"\r\n")
	require.NoError(t, err)

	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)
	return conn, reader, response
}

func TestTerminalRelaysInputAndOutput(t *testing.T) {
	server, _ := newTestServer(t)
	conn, reader, response := openTerminal(
		t, serve(t, server), "/api/v1/services/web/terminal?container=abc", "Connection: Upgrade\r\nUpgrade: terminal\r\n",
	)
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
	assert.Equal(t, "terminal", response.Header.Get("Upgrade"))

	_, err := io.WriteString(conn, `{"resize":[120,40]}{"stdin":"ls\n"}{"stdin":"exit"}`)
	require.NoError(t, err)

	// The shell exiting closes the connection.
	output, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, "shell in web/abc\nsize 120x40\nls\n", string(output))
}

func TestTerminalWritesErrorsToTheTerminal(t *testing.T) {
	server, backend := newTestServer(t)
	backend.execErr = errors.New("service web has no running container")
	_, reader, response := openTerminal(t, serve(t, server), "/api/v1/services/web/terminal", "Connection: Upgrade\r\nUpgrade: terminal\r\n")
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)

	output, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, "\r\nservice web has no running container\r\n", string(output))
}

// fakeExecDocker answers an exec stream like Uncloud: it names the exec, then reports sizes and echoes
// stdin until it reads "exit".
type fakeExecDocker struct {
	pb.UnimplementedDockerServer
}

func (fakeExecDocker) ExecContainer(stream pb.Docker_ExecContainerServer) error {
	request, err := stream.Recv()
	if err != nil {
		return err
	}
	var options api.ExecOptions
	if err := json.Unmarshal(request.GetConfig().GetOptions(), &options); err != nil {
		return err
	}
	if err := stream.Send(&pb.ExecContainerResponse{Payload: &pb.ExecContainerResponse_ExecId{ExecId: "exec-1"}}); err != nil {
		return err
	}
	stdout := func(text string) error {
		return stream.Send(&pb.ExecContainerResponse{Payload: &pb.ExecContainerResponse_Stdout{Stdout: []byte(text)}})
	}
	if err := stdout(fmt.Sprintf("%s tty=%t stdin=%t\n", request.GetConfig().GetContainerId(), options.Tty, options.AttachStdin)); err != nil {
		return err
	}

	for {
		request, err := stream.Recv()
		if err != nil {
			return err
		}
		if size := request.GetResize(); size != nil {
			err = stdout(fmt.Sprintf("size %dx%d\n", size.Width, size.Height))
		} else if string(request.GetStdin()) == "exit" {
			return stream.Send(&pb.ExecContainerResponse{Payload: &pb.ExecContainerResponse_ExitCode{ExitCode: 0}})
		} else {
			err = stdout(string(request.GetStdin()))
		}
		if err != nil {
			return err
		}
	}
}

func TestExecTerminalDrivesTheExecStream(t *testing.T) {
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterDockerServer(server, fakeExecDocker{})
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	conn, err := bufconnConnector{listener: listener}.Connect(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	input := make(chan TerminalInput, 3)
	input <- TerminalInput{Resize: &[2]uint32{120, 40}}
	input <- TerminalInput{Stdin: "ls\n"}
	input <- TerminalInput{Stdin: "exit"}
	close(input)

	var output bytes.Buffer
	require.NoError(t, execTerminal(t.Context(), pb.NewDockerClient(conn), "abc", terminalCommand, input, &output))
	assert.Equal(t, "abc tty=true stdin=true\nsize 120x40\nls\n", output.String())
}

func TestTerminalRequiresUpgrade(t *testing.T) {
	server, _ := newTestServer(t)
	_, _, response := openTerminal(t, serve(t, server), "/api/v1/services/web/terminal", "")
	assert.Equal(t, http.StatusUpgradeRequired, response.StatusCode)
	assert.Equal(t, "terminal", response.Header.Get("Upgrade"))
}
