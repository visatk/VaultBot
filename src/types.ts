export interface BroadcastMessage {
  userId: number;
  text: string;
}

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BROADCAST_QUEUE: Queue<BroadcastMessage>;
  TELEGRAM_BOT_TOKEN: string;
  APIRONE_ACCOUNT: string;
  WEBHOOK_URL: string;
  WEBHOOK_SECRET: string;
  PRICE_PER_CARD_USD: string;
  ADMIN_USER_ID: number;
}

export const CURRENCIES: Record<string, { name: string, decimals: number }> = {
  'btc': { name: 'Bitcoin (BTC)', decimals: 8 },
  'ltc': { name: 'Litecoin (LTC)', decimals: 8 },
  'trx': { name: 'TRON (TRX)', decimals: 6 },
  'usdt@trx': { name: 'USDT (TRC20)', decimals: 6 }
};

export type GenerationType = 
  | 'RANDOM' | 'BIN' | 'COUNTRY' 
  | 'BRAND_VISA' | 'BRAND_MASTERCARD' | 'BRAND_AMEX' 
  | 'TYPE_CREDIT' | 'TYPE_DEBIT';

export interface UserState {
  action: 'WAITING_FOR_BIN' | 'WAITING_FOR_COUNTRY' | 'WAITING_FOR_TOPUP';
  generationType?: GenerationType;
  filterValue?: string;
}
