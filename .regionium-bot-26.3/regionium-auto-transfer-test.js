const mineflayer = require('./mineflayer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bot = mineflayer.createBot({
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 25565),
  username: process.env.BOT_USERNAME || 'RegioniumBot26_3',
  auth: 'offline',
  version: '26.3'
});

let last = null;
let samples = 0;
let stalls = 0;
let jumps = 0;
let minX = Infinity;
let maxX = -Infinity;

// Fabric registry sync completion used by the server during configuration.
bot._client.on('custom_payload', packet => {
  if (packet.channel === 'fabric:registry/sync') {
    bot._client.write('custom_payload', {
      channel: 'fabric:registry/sync/complete',
      data: Buffer.alloc(0)
    });
    console.log('FABRIC_REGISTRY_SYNC_COMPLETE');
  }
});

function pos(tag) {
  if (!bot.entity) return;
  const p = bot.entity.position;
  console.log(tag + ' x=' + p.x.toFixed(2) + ' y=' + p.y.toFixed(2) + ' z=' + p.z.toFixed(2));
}

bot.once('spawn', async () => {
  console.log('SPAWN ' + bot.entity.position.toString());

  await bot.look(-Math.PI / 2, 0, true);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);

  for (let i = 1; i <= 4; i++) {
    await sleep(12000);
    pos('EAST_' + i);
  }

  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  await sleep(1500);

  await bot.look(Math.PI / 2, 0, true);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);

  for (let i = 1; i <= 4; i++) {
    await sleep(12000);
    pos('WEST_' + i);
  }

  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  await sleep(1000);

  pos('FINAL');
  console.log('RESULT ' + JSON.stringify({samples, stalls, jumps, minX, maxX}));
  bot.quit();
});

const sampler = setInterval(() => {
  if (!bot.entity) return;
  const p = bot.entity.position;
  minX = Math.min(minX, p.x);
  maxX = Math.max(maxX, p.x);

  if (last) {
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    if (d < 0.02) stalls++;
    if (d > 4) {
      jumps++;
      console.log('LARGE_POSITION_JUMP ' + d.toFixed(2));
    }
  }

  last = p.clone();
  samples++;
  if (samples % 10 === 0) pos('POS');
}, 200);

bot.on('error', e => console.error('ERROR', e));
bot.on('kicked', r => console.error('KICKED', r));
bot.on('end', r => {
  clearInterval(sampler);
  console.log('END ' + (r || ''));
});

setTimeout(() => {
  console.error('TIMEOUT');
  bot.quit();
  process.exitCode = 2;
}, 115000);
