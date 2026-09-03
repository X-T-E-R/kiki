import * as vscode from "vscode";

import type { DaemonConnection } from "./daemon";

export interface WebviewConnection extends DaemonConnection {
  readonly restOrigin: string;
  readonly socketOrigin: string;
}

export async function resolveWebviewConnection(
  connection: DaemonConnection,
  asExternalUri: (uri: vscode.Uri) => Thenable<vscode.Uri> = vscode.env.asExternalUri,
): Promise<WebviewConnection> {
  const external = await asExternalUri(vscode.Uri.parse(connection.url));
  const url = external.toString(true).replace(/\/$/, "");
  const restOrigin = new URL(url).origin;
  const socket = new URL(restOrigin);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  return {
    url,
    token: connection.token,
    restOrigin,
    socketOrigin: socket.origin,
  };
}
