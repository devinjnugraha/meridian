import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, '..', '..', 'user-config.json');

function getToken() {
	return process.env.TELEGRAM_BOT_TOKEN || null;
}

function getBase() {
	const token = getToken();
	return token ? `https://api.telegram.org/bot${token}` : null;
}

function resolveChatId() {
	if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
	try {
		if (fs.existsSync(USER_CONFIG_PATH)) {
			const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'));
			if (cfg.telegramChatId) return cfg.telegramChatId;
		}
	} catch {
		/* best-effort */
	}
	return null;
}

export function isEnabled() {
	return !!getToken() && !!resolveChatId();
}

async function post(method, body) {
	const token = getToken();
	const base = getBase();
	const chatId = resolveChatId();

	if (!token || !chatId || !base) return null;

	try {
		const res = await fetch(`${base}/${method}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, ...body }),
		});
		if (!res.ok) {
			log('telegram_error', `${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
			return null;
		}
		return await res.json();
	} catch (e) {
		log('telegram_error', `${method} failed: ${e.message}`);
		return null;
	}
}

export async function sendMessage(text) {
	return post('sendMessage', { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html, retries = 2) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		const res = await post('sendMessage', { text: html.slice(0, 4096), parse_mode: 'HTML' });
		if (res) return res;
		if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
	}
	const plain = html.replace(/<\/?[bip]>/g, '').replace(/<[^>]+>/g, '');
	log('telegram_warn', 'sendHTML failed, falling back to plain text');
	return post('sendMessage', { text: plain.slice(0, 4096) });
}
