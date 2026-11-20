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

const text = (value: string) => new TextEncoder().encode(value);

/**
 * An ed25519 key pair: the OpenSSH public key to authorize, and the private key in OpenSSH's own
 * format. Every OpenSSH, Uncloud's Go SSH client and ssh2 read it; OpenSSH before 10 can't read
 * an ed25519 key as PKCS#8 PEM.
 */
export async function sshKeyPair(comment: string) {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);

    if (!("privateKey" in pair)) throw new Error("Ed25519 must generate a key pair.");

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    // An ed25519 PKCS#8 key ends with its 32-byte seed.
    const seed = pkcs8.slice(-32);
    const blob = new Uint8Array([...sshString(text("ssh-ed25519")), ...sshString(raw)]);
    // Two equal random words, which tell a reader the (unencrypted) key decoded right.
    const check = crypto.getRandomValues(new Uint8Array(4));

    const secret = [
        ...check,
        ...check,
        ...sshString(text("ssh-ed25519")),
        ...sshString(raw),
        ...sshString(new Uint8Array([...seed, ...raw])),
        ...sshString(text(comment)),
    ];

    // Padded with 1, 2, 3, ... to the cipher block size, 8 without encryption.
    for (let pad = 1; secret.length % 8 !== 0; pad++) secret.push(pad);

    const key = new Uint8Array([
        ...text("openssh-key-v1\0"),
        ...sshString(text("none")),
        ...sshString(text("none")),
        ...sshString(new Uint8Array()),
        // uint32 number of keys: 1.
        0,
        0,
        0,
        1,
        ...sshString(blob),
        ...sshString(new Uint8Array(secret)),
    ]);

    return {
        publicKey: `ssh-ed25519 ${base64(blob)} ${comment}`,
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64(key)
            .match(/.{1,70}/gu)!
            .join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    };
}
