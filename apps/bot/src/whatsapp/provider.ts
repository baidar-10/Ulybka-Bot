export interface WhatsAppProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;
}
