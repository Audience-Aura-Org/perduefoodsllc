import { config, mailConfigured } from './src/config.js';
import { createApp } from './src/app.js';

// Production mode (template caching) unless started with --dev or NODE_ENV=development.
const production = config.production && !process.argv.includes('--dev');
const app = createApp({ production });

const server = app.listen(config.port, config.host, () => {
  console.log(`Perdue Farms offline site running at http://${config.host}:${config.port}/ (${production ? 'production' : 'development'} mode)`);
  console.log(mailConfigured()
    ? `Email notifications: ${config.mail.host}:${config.mail.port} as ${config.mail.user} -> ${config.mail.to}`
    : 'Email notifications: disabled (set SMTP_USER, SMTP_PASS and MAIL_TO in .env); submissions are still saved to storage/');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
