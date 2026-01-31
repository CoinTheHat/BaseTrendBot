import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/env';

async function testTelegram() {
    console.log('🧪 Testing Telegram Connection...');
    console.log(`Token: ${config.TELEGRAM_BOT_TOKEN ? '✅ Found' : '❌ Missing'}`);
    console.log(`Chat ID: ${config.TELEGRAM_CHAT_ID || '❌ Missing'}`);

    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        console.error('❌ Missing Telegram credentials in .env');
        process.exit(1);
    }

    const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });

    try {
        const me = await bot.getMe();
        console.log(`✅ Bot Connected: @${me.username} (${me.first_name})`);

        const testMessage = `🧪 **TEST MESSAGE**

📡 Bot Status: ONLINE
🕐 Time: ${new Date().toLocaleString('tr-TR')}
💬 Chat ID: \`${config.TELEGRAM_CHAT_ID}\`

✅ Telegram notifications working!`;

        const result = await bot.sendMessage(config.TELEGRAM_CHAT_ID, testMessage, {
            parse_mode: 'Markdown'
        });

        console.log('✅ Test message sent successfully!');
        console.log(`Message ID: ${result.message_id}`);
        console.log(`\n📱 Check your Telegram now!`);

    } catch (error: any) {
        console.error('❌ Failed to send message:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.body);
        }
    }

    process.exit(0);
}

testTelegram();
