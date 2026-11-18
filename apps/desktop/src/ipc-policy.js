export function assertTrustedSender(event, expectedUrl) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expectedUrl) {
    throw new Error("Untrusted IPC sender");
  }
}
