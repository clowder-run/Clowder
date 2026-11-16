package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humafiber"
	"github.com/psviderski/uncloud/api/pb"
	"github.com/psviderski/uncloud/pkg/api"
)

// terminalProtocol is the Upgrade token of an interactive shell in a container.
const terminalProtocol = "terminal"

// terminalCommand prefers bash, falling back to sh for images such as Alpine.
var terminalCommand = []string{"sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"}

// TerminalInput is one JSON value a terminal client sends: keystrokes, a new size, or both.
type TerminalInput struct {
	Stdin  string     `json:"stdin,omitempty"`
	Resize *[2]uint32 `json:"resize,omitempty"`
}

type terminalInput struct {
	ID         string `path:"id" doc:"Service name or ID."`
	Container  string `query:"container" doc:"Container name or ID. Defaults to a running container of the service."`
	Connection string `header:"Connection" doc:"Must list Upgrade."`
	Upgrade    string `header:"Upgrade" doc:"Must be terminal."`
}

// terminal runs a shell in a container. After the 101 the client sends TerminalInput values as a
// JSON stream and reads the raw TTY output; the shell exiting closes the connection.
func (s *Server) terminal(_ context.Context, input *terminalInput) (*huma.StreamResponse, error) {
	if err := requireUpgrade(input.Connection, input.Upgrade, terminalProtocol); err != nil {
		return nil, err
	}

	return &huma.StreamResponse{Body: func(ctx huma.Context) {
		request := humafiber.Unwrap(ctx).RequestCtx()
		request.HijackSetNoResponse(true)
		request.Hijack(func(conn net.Conn) {
			if _, err := io.WriteString(conn, switchingProtocols(terminalProtocol)); err != nil {
				return
			}

			// A shell lives as long as its client, not the request deadline.
			shellCtx, cancel := streamContext(ctx.Context())
			defer cancel()

			messages := make(chan TerminalInput)
			reading := make(chan struct{})
			go func() {
				// The client hanging up ends the shell.
				defer cancel()
				defer close(reading)
				defer close(messages)
				decoder := json.NewDecoder(conn)
				for {
					var message TerminalInput
					if decoder.Decode(&message) != nil {
						return
					}
					select {
					case messages <- message:
					case <-shellCtx.Done():
						return
					}
				}
			}()

			err := s.backend.Terminal(shellCtx, input.ID, input.Container, terminalCommand, messages, conn)
			if err != nil && shellCtx.Err() == nil {
				_, _ = fmt.Fprintf(conn, "\r\n%s\r\n", err)
			}

			// fasthttp reuses the connection's reader once this returns, so stop reading first.
			// A hijacked connection ignores Close until then, so a deadline unblocks the read.
			cancel()
			_ = conn.SetReadDeadline(time.Now())
			<-reading
		})
	}}, nil
}

// Terminal drives Uncloud's exec stream itself: its ExecContainer only attaches a TTY to the
// process's own stdin, which the sidecar does not have.
func (b *clientBackend) Terminal(
	ctx context.Context, serviceID, containerID string, command []string,
	input <-chan TerminalInput, output io.Writer,
) error {
	target, err := b.terminalContainer(ctx, serviceID, containerID)
	if err != nil {
		return err
	}
	ctx = b.Client.ProxySingleMachineContext(ctx, target.MachineID)
	return execTerminal(ctx, b.Client.Docker.GRPCClient, target.Container.ID, command, input, output)
}

// execTerminal runs command in a TTY in the container on the machine ctx proxies to.
func execTerminal(
	ctx context.Context, docker pb.DockerClient, containerID string, command []string,
	input <-chan TerminalInput, output io.Writer,
) error {
	options, err := json.Marshal(api.ExecOptions{Command: command, AttachStdin: true, AttachStdout: true, Tty: true})
	if err != nil {
		return err
	}

	stream, err := docker.ExecContainer(ctx)
	if err != nil {
		return fmt.Errorf("open exec stream: %w", err)
	}
	if err := stream.Send(&pb.ExecContainerRequest{Payload: &pb.ExecContainerRequest_Config{
		Config: &pb.ExecConfig{ContainerId: containerID, Options: options},
	}}); err != nil {
		return fmt.Errorf("start exec: %w", err)
	}

	go func() {
		defer func() { _ = stream.CloseSend() }()
		for message := range input {
			if message.Resize != nil {
				size := &pb.ResizeEvent{Width: message.Resize[0], Height: message.Resize[1]}
				if stream.Send(&pb.ExecContainerRequest{Payload: &pb.ExecContainerRequest_Resize{Resize: size}}) != nil {
					return
				}
			}
			if message.Stdin != "" {
				if stream.Send(&pb.ExecContainerRequest{Payload: &pb.ExecContainerRequest_Stdin{Stdin: []byte(message.Stdin)}}) != nil {
					return
				}
			}
		}
	}()

	for {
		response, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch payload := response.Payload.(type) {
		case *pb.ExecContainerResponse_Stdout:
			if _, err := output.Write(payload.Stdout); err != nil {
				return err
			}
		case *pb.ExecContainerResponse_Stderr:
			if _, err := output.Write(payload.Stderr); err != nil {
				return err
			}
		case *pb.ExecContainerResponse_ExitCode:
			return nil
		}
	}
}

// terminalContainer is the named container, or the service's first running one.
func (b *clientBackend) terminalContainer(ctx context.Context, serviceID, containerID string) (api.MachineServiceContainer, error) {
	if containerID != "" {
		return b.Client.InspectContainer(ctx, serviceID, containerID)
	}

	service, err := b.Client.InspectService(ctx, serviceID)
	if err != nil {
		return api.MachineServiceContainer{}, err
	}
	for _, candidate := range service.Containers {
		if candidate.Container.State != nil && candidate.Container.State.Running {
			return candidate, nil
		}
	}
	return api.MachineServiceContainer{}, fmt.Errorf("service %s has no running container", service.Name)
}
