require('dotenv').config();
import { Connection, PublicKey, LogsCallback } from '@solana/web3.js';
import { Buffer } from 'buffer';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

// Constants
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8NQtEhJk8u5EDiyo3G81TpKyz5J');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CONFIDENCE_THRESHOLD = 70; // Tune: only alert on high-confidence signals
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// Telegram bot setup
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN as string, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID as string;

// Solana connection (Helius free tier)
const connection = new Connection(HELIUS_RPC);

// Decode Create instruction data (manual parse: u32 len + string x3 + pubkey x3)
function decodeCreateData(data: Buffer): { name: string; symbol: string; uri: string; mint: PublicKey; bondingCurve: PublicKey; user: PublicKey } {
  let offset = 0;
  const nameLen = data.readUInt32LE(offset); offset += 4;
  const name = data.slice(offset, offset + nameLen).toString('utf-8'); offset += nameLen;
  const symbolLen = data.readUInt32LE(offset); offset += 4;
  const symbol = data.slice(offset, offset + symbolLen).toString('utf-8'); offset += symbolLen;
  const uriLen = data.readUInt32LE(offset); offset += 4;
  const uri = data.slice(offset, offset + uriLen).toString('utf-8'); offset += uriLen;
  const mint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const bondingCurve = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const user = new PublicKey(data.slice(offset, offset + 32));
  return { name, symbol, uri, mint, bondingCurve, user };
}

// Derive associated bonding curve PDA
async function getAssociatedBondingCurve(bondingCurve: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const [assoc] = await PublicKey.findProgramAddress(
    [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return assoc;
}

// Birdeye enrichment (price + MC)
async function getBirdeyeData(mint: string): Promise<{ price?: number; mc?: number }> {
  try {
    const res = await axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
      headers: { 'X-API-KEY': process.env.BIRDSEYE_API_KEY, 'X-CHAIN': 'solana' }
    });
    const data = res.data.data;
    return { price: data?.price, mc: data?.mc };
  } catch (e) {
    console.error('Birdeye error:', e);
    return {};
  }
}

// Basic smart-wallet check (e.g., creator has >1 SOL balance = potential smart money)
async function isSmartWallet(user: PublicKey): Promise<boolean> {
  const balance = await connection.getBalance(user);
  return balance > 1_000_000_000; // 1 SOL threshold
}

// Confidence scoring (curate high-signal: metadata quality + smart wallet)
async function calculateConfidence(params: { name: string; symbol: string; uri: string; user: PublicKey }): Promise<number> {
  const { name, symbol, uri, user } = params;
  let score = 0;
  if (name.length > 3 && !name.includes('scam')) score += 20; // Basic name filter
  if (symbol.length > 1) score += 20;
  if (uri.startsWith('https://') && uri.endsWith('.json')) score += 30; // Valid metadata URI
  if (await isSmartWallet(user)) score += 30; // Smart wallet boost
  return score;
}

// WebSocket logs subscription (Helius via standard RPC)
const logsCallback: LogsCallback = async (logs, context) => {
  if (logs.err) return;
  const logLines = logs.logs;
  if (logLines.some(l => l.includes('Program log: Instruction: Create'))) {
    const dataLine = logLines.find(l => l.startsWith('Program data: '));
    if (dataLine) {
      const dataB64 = dataLine.split('Program data: ')[1];
      const dataBuffer = Buffer.from(dataB64, 'base64');
      try {
        const decoded = decodeCreateData(dataBuffer);
        const [assoc, birdeye, score] = await Promise.all([
          getAssociatedBondingCurve(decoded.bondingCurve, decoded.mint),
          getBirdeyeData(decoded.mint.toBase58()),
          calculateConfidence(decoded)
        ]);
        if (score >= CONFIDENCE_THRESHOLD) {
          const message = `
New High-Confidence Pump.fun Launch Detected!
Name: ${decoded.name}
Symbol: ${decoded.symbol}
URI: ${decoded.uri}
Mint: ${decoded.mint.toBase58()}
Bonding Curve: ${decoded.bondingCurve.toBase58()}
Associated Curve: ${assoc.toBase58()}
Creator: ${decoded.user.toBase58()}
Price: $${birdeye.price ?? 'N/A'}
Market Cap: $${birdeye.mc ?? 'N/A'}
Confidence Score: ${score}/100
Signature: ${logs.signature}
          `;
          await bot.sendMessage(chatId, message);
          console.log('Alert sent:', decoded.name);
        } else {
          console.log('Low confidence launch skipped:', decoded.name, score);
        }
      } catch (e) {
        console.error('Decode/process error:', e);
      }
    }
  }
};

// Start listening
connection.onLogs(PUMP_PROGRAM_ID, logsCallback, 'processed');
console.log('TrenchPing MVP running: Listening for new Pump.fun launches on Helius WebSockets...');
