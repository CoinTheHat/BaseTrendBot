import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === 'YOUR_BOT_TOKEN') {
    console.error('❌ Error: Please set TELEGRAM_BOT_TOKEN in your .env file first.');
    process.exit(1);
}

// Polling is more reliable for catching new channel posts
const bot = new TelegramBot(token, { polling: true });

console.log('🔄 Listening for new messages... (Press Ctrl+C to stop)');
console.log('👉 Please send a message to your Channel NOW.');

bot.on('channel_post', (msg) => {
    console.log(`\n✅ CHANNEL DETECTED!`);
    console.log(`   - Title: ${msg.chat.title}`);
    console.log(`   - ID: ${msg.chat.id}`);
    console.log(`\n📋 COPY THIS ID: ${msg.chat.id}`);
    console.log('Paste it into your .env file as TELEGRAM_CHAT_ID');
    process.exit(0);
});

bot.on('message', (msg) => {
    if (msg.chat.type === 'private') {
        console.log(`\n👤 Private Chat Detected (You): ${msg.chat.id}`);
        console.log('   (If you want to use this DM, copy this ID. If you want a channel, post in the channel now.)');
    } else if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') {
        console.log(`\n👥 Group Detected: ${msg.chat.title}, ID: ${msg.chat.id}`);
    }
});
