const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(process.argv[2] || path.join(__dirname, '../../chat-bot-whatsapp'));
const destination = path.resolve(__dirname, '../src');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}
function messages(text) {
  const patterns = [
    /\b(?:defaultLogger|logger)\.(?:info|warn|error|debug)(?:\?\.)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
    /\blog\(\s*['"](?:info|warn|error|debug)['"],\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
  ];
  return new Set(patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[2].replace(/\$\{[^}]+\}/g, '${}'))));
}
const originFiles = ['app.js', ...['flow', 'services', 'helpers'].flatMap((name) => files(path.join(source, name)).map((f) => path.relative(source, f)))];
const targetText = files(destination).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const targetMessages = messages(targetText);
const replacements = new Map([
  ['Fallo de sesión WhatsApp; revisar baileys.log', 'Fallo de sesión WhatsApp; revisar logs/bot.log'],
]);
let checked = 0;
const missing = [];
const targetActions = new Set([...targetText.matchAll(/action:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
const missingActions = [];
for (const relative of originFiles) {
  const originText = fs.readFileSync(path.join(source, relative), 'utf8');
  for (const message of messages(originText)) {
    checked++;
    if (!targetMessages.has(replacements.get(message) || message)) missing.push({ file: relative, message });
  }
  for (const action of new Set([...originText.matchAll(/action:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]))) {
    if (!targetActions.has(action)) missingActions.push({ file: relative, action });
  }
}
console.log(JSON.stringify({ checkedMessages: checked, missing, missingActions, providerSpecificReplacements: Object.fromEntries(replacements) }, null, 2));
if (missing.length || missingActions.length) process.exitCode = 1;
