import { isAllowedS3Address } from "@clowder/s3/client";
import { BlockList, isIP } from "node:net";

const privateNetworks = new BlockList();

// RFC 1918 and IPv6 unique local addresses.
for (const [address, prefix, type] of [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["fc00::", 7, "ipv6"],
] satisfies [string, number, "ipv4" | "ipv6"][]) {
    privateNetworks.addSubnet(address, prefix, type);
}

/** Whether Clowder reaches this server over a private network (LAN) rather than the internet. */
export function isPrivateServerAddress(address: string) {
    const version = isIP(address);

    return version !== 0 && privateNetworks.check(address, version === 6 ? "ipv6" : "ipv4");
}

/** Same policy as S3 endpoints and Git hosts (loopback, link-local and metadata never). */
export function isAllowedServerAddress(address: string) {
    return isAllowedS3Address(address);
}
