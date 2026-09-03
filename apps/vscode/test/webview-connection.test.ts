import { describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  class Uri {
    constructor(private readonly value: string) {}
    static parse(value: string): Uri {
      return new Uri(value);
    }
    toString(): string {
      return this.value;
    }
  }
  return { Uri };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  env: { asExternalUri: vi.fn() },
}));

import { resolveWebviewConnection } from "../src/webview-connection";

describe("remote Webview connection", () => {
  it("uses the external REST origin and derives its WebSocket origin", async () => {
    const asExternalUri = vi.fn(async () =>
      host.Uri.parse("https://remote-tunnel.example.test/forwarded/8123/"),
    );

    await expect(
      resolveWebviewConnection(
        { url: "http://127.0.0.1:8123", token: "token" },
        asExternalUri as never,
      ),
    ).resolves.toEqual({
      url: "https://remote-tunnel.example.test/forwarded/8123",
      token: "token",
      restOrigin: "https://remote-tunnel.example.test",
      socketOrigin: "wss://remote-tunnel.example.test",
    });
    expect(asExternalUri).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
    );
  });
});
