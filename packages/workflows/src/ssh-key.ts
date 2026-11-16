// Client-safe: WebCrypto runs the same in Node and the browser, so servers and users share it.

// An SSH wire-format string: a 32-bit big-endian length, then the bytes.
function sshString(value: Uint8Array) {
    const out = new Uint8Array(4 + value.length);

    new DataView(out.buffer).setUint32(0, value.length);
    out.set(value, 4);

    return out;
}

function base64(bytes: Uint8Array) {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/**
 * An ed25519 key pair: the OpenSSH public key to authorize, and the private key as PKCS#8 PEM,
 * which both OpenSSH and Uncloud's Go SSH client read.
 */
export async function sshKeyPair(comment: string) {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);

    if (!("privateKey" in pair)) throw new Error("Ed25519 must generate a key pair.");

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const type = new TextEncoder().encode("ssh-ed25519");
    const blob = new Uint8Array([...sshString(type), ...sshString(raw)]);

    return {
        publicKey: `ssh-ed25519 ${base64(blob)} ${comment}`,
        privateKey: `-----BEGIN PRIVATE KEY-----\n${base64(pkcs8)
            .match(/.{1,64}/gu)!
            .join("\n")}\n-----END PRIVATE KEY-----\n`,
    };
}
