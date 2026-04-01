import 'dotenv/config';
import {
  Client, GatewayIntentBits, Routes, REST, EmbedBuilder, Colors,
  PermissionFlagsBits, ChannelType
} from 'discord.js';
import fs from 'fs';
import path from 'path';

const { DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APP_ID || !GUILD_ID) throw new Error('Brak env DISCORD_TOKEN / DISCORD_APP_ID / GUILD_ID');
const BACKUP_OWNER_ID = '1378291577973379117';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BACKUP_PATH = path.join(DATA_DIR, 'server-backup.json');
let guildConfig = {};
const tempChannels = new Map(); // channelId -> { ownerId, banned:Set<string> }

function loadConfig() { try { guildConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { guildConfig = {}; } }
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(guildConfig, null, 2), 'utf8'); }
loadConfig();

function ensureGuild(gid) {
  const g = guildConfig[gid] || {};
  g.commandChannelId = g.commandChannelId ?? null;
  g.logChannelId = g.logChannelId ?? null;
  g.complaintChannelId = g.complaintChannelId ?? null;
  g.praiseChannelId = g.praiseChannelId ?? null;
  g.dcCommandChannelId = g.dcCommandChannelId ?? null;
  g.dcLogChannelId = g.dcLogChannelId ?? null;
  g.unbanChannelId = g.unbanChannelId ?? null;
  g.tempVoiceTemplateId = g.tempVoiceTemplateId ?? null;
  g.channelRoleIds = Array.isArray(g.channelRoleIds) ? g.channelRoleIds : [];
  g.banRoleIds = Array.isArray(g.banRoleIds) ? g.banRoleIds : [];
  g.unbanRoleIds = Array.isArray(g.unbanRoleIds) ? g.unbanRoleIds : [];
  g.visibilityOnRoleIds = Array.isArray(g.visibilityOnRoleIds) ? g.visibilityOnRoleIds : [];
  g.visibilityOffRoleIds = Array.isArray(g.visibilityOffRoleIds) ? g.visibilityOffRoleIds : [];
  g.banRecords = Array.isArray(g.banRecords) ? g.banRecords : [];
  g.tempVoiceChannels = g.tempVoiceChannels && typeof g.tempVoiceChannels === 'object' ? g.tempVoiceChannels : {};
  guildConfig[gid] = g;
  return g;
}

function getTempMeta(gid, channelId) {
  const cfg = ensureGuild(gid);
  const stored = cfg.tempVoiceChannels[channelId];
  if (!stored) return null;
  return {
    ownerId: stored.ownerId,
    banned: new Set(Array.isArray(stored.bannedUserIds) ? stored.bannedUserIds : [])
  };
}

function setTempMeta(gid, channelId, meta) {
  const cfg = ensureGuild(gid);
  cfg.tempVoiceChannels[channelId] = {
    ownerId: meta.ownerId,
    bannedUserIds: Array.from(meta.banned ?? [])
  };
  saveConfig();
}

function deleteTempMeta(gid, channelId) {
  const cfg = ensureGuild(gid);
  delete cfg.tempVoiceChannels[channelId];
  saveConfig();
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    // 40060 = Discord uznal interakcje za juz obsluzona; probujemy followUp.
    if (err?.code === 40060) {
      try {
        return await interaction.followUp(payload);
      } catch (followErr) {
        if (followErr?.code !== 10062 && followErr?.code !== 40060) {
          throw followErr;
        }
        return;
      }
    }
    // 10062 = interakcja wygasla; nie wysypujemy procesu.
    if (err?.code !== 10062) {
      throw err;
    }
  }
}

function hasAllowedRole(member, ids = []) {
  const arr = Array.isArray(ids) ? ids : [];
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(r => arr.includes(r.id));
}
function isCommandVisible(member, cfg, commandName) {
  if (['skarga', 'pochwala'].includes(commandName)) return true;
  if (['vc-name', 'vc-limit', 'vc-kick', 'vc-ban', 'vc-close'].includes(commandName)) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const hasOff = member.roles.cache?.some(r => cfg.visibilityOffRoleIds.includes(r.id));
  if (hasOff) return false;
  if (cfg.visibilityOnRoleIds.length === 0) return false; // domyślnie zwykli widzą tylko /skarga
  return member.roles.cache?.some(r => cfg.visibilityOnRoleIds.includes(r.id));
}
function formatDuration(input) {
  const raw = (input || '').trim().toLowerCase();
  if (['perm', 'perma', 'permanent', 'permanentny', 'na zawsze'].includes(raw)) return 'Na zawsze';
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) return `${n} ${Math.abs(n) === 1 ? 'dzień' : 'dni'}`;
  return input || 'brak danych';
}
function parseDurationMs(str) {
  const raw = (str || '').trim().toLowerCase();
  if (!raw) return null;
  if (['perm', 'perma', 'permanent', 'permanentny', 'na zawsze'].includes(raw)) return null;
  const m = raw.match(/^(\d+)\s*([mhd])?$/);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  const unit = m[2] || 'm';
  const mult = unit === 'h' ? 60 : unit === 'd' ? 1440 : 1;
  return value * mult * 60 * 1000;
}
function generateId(prefix = 'BAN') {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = `${prefix}-`;
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function isBackupOwner(user) {
  return user?.id === BACKUP_OWNER_ID;
}

function serializeOverwrite(overwrite) {
  return {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  };
}

function serializeRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position
  };
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    position: channel.rawPosition ?? channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    permissionOverwrites: channel.permissionOverwrites?.cache?.map(serializeOverwrite) ?? []
  };
}

function saveServerSnapshot(guild) {
  const roles = guild.roles.cache
    .filter(role => !role.managed && role.id !== guild.id)
    .sort((a, b) => a.position - b.position)
    .map(serializeRole);

  const channels = guild.channels.cache
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .map(serializeChannel);

  const snapshot = {
    savedAt: new Date().toISOString(),
    guildId: guild.id,
    guildName: guild.name,
    roles,
    channels
  };

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshot;
}

async function restoreServerSnapshot(guild) {
  if (!fs.existsSync(BACKUP_PATH)) {
    throw new Error('Brak zapisanego backupu serwera.');
  }

  const snapshot = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const roleIdMap = new Map([[guild.id, guild.id]]);

  const existingRolesByName = new Map(
    guild.roles.cache
      .filter(role => !role.managed)
      .map(role => [role.name, role])
  );

  for (const savedRole of snapshot.roles) {
    let role = existingRolesByName.get(savedRole.name);
    if (!role) {
      role = await guild.roles.create({
        name: savedRole.name,
        color: savedRole.color,
        hoist: savedRole.hoist,
        mentionable: savedRole.mentionable,
        permissions: BigInt(savedRole.permissions)
      });
      existingRolesByName.set(savedRole.name, role);
    } else {
      await role.edit({
        name: savedRole.name,
        color: savedRole.color,
        hoist: savedRole.hoist,
        mentionable: savedRole.mentionable,
        permissions: BigInt(savedRole.permissions)
      });
    }
    roleIdMap.set(savedRole.id, role.id);
  }

  const sortedRoles = [...snapshot.roles].sort((a, b) => a.position - b.position);
  for (const savedRole of sortedRoles) {
    const currentRoleId = roleIdMap.get(savedRole.id);
    const currentRole = currentRoleId ? guild.roles.cache.get(currentRoleId) : null;
    if (currentRole) {
      await currentRole.setPosition(Math.max(1, savedRole.position)).catch(() => {});
    }
  }

  const existingChannelsByKey = new Map(
    guild.channels.cache.map(channel => [`${channel.type}:${channel.parentId ?? 'root'}:${channel.name}`, channel])
  );
  const channelIdMap = new Map();

  const categories = snapshot.channels.filter(channel => channel.type === ChannelType.GuildCategory);
  const nonCategories = snapshot.channels.filter(channel => channel.type !== ChannelType.GuildCategory);

  for (const savedChannel of [...categories, ...nonCategories]) {
    const parentId = savedChannel.parentId ? channelIdMap.get(savedChannel.parentId) ?? savedChannel.parentId : null;
    const key = `${savedChannel.type}:${parentId ?? 'root'}:${savedChannel.name}`;
    let channel = existingChannelsByKey.get(key);

    const overwrites = savedChannel.permissionOverwrites.map(overwrite => ({
      id: overwrite.type === 0 ? (roleIdMap.get(overwrite.id) ?? overwrite.id) : overwrite.id,
      type: overwrite.type,
      allow: BigInt(overwrite.allow),
      deny: BigInt(overwrite.deny)
    }));

    const editPayload = {
      name: savedChannel.name,
      parent: parentId,
      position: savedChannel.position,
      permissionOverwrites: overwrites
    };

    if (savedChannel.type === ChannelType.GuildText) {
      editPayload.topic = savedChannel.topic;
      editPayload.nsfw = savedChannel.nsfw;
      editPayload.rateLimitPerUser = savedChannel.rateLimitPerUser;
    }

    if (savedChannel.type === ChannelType.GuildVoice) {
      editPayload.bitrate = savedChannel.bitrate;
      editPayload.userLimit = savedChannel.userLimit;
    }

    if (!channel) {
      channel = await guild.channels.create({
        name: savedChannel.name,
        type: savedChannel.type,
        parent: parentId,
        topic: savedChannel.topic,
        nsfw: savedChannel.nsfw,
        rateLimitPerUser: savedChannel.rateLimitPerUser,
        bitrate: savedChannel.bitrate,
        userLimit: savedChannel.userLimit,
        permissionOverwrites: overwrites
      });
      existingChannelsByKey.set(key, channel);
    } else {
      await channel.edit(editPayload).catch(() => {});
    }

    channelIdMap.set(savedChannel.id, channel.id);
  }

  return snapshot;
}

const commands = [
  { name: 'ban-eh', description: 'Wizualny ban (EH)', options: [
    { name: 'nick', description: 'Nick z gry', type: 3, required: true },
    { name: 'reason', description: 'Powód', type: 3, required: true },
    { name: 'days', description: 'Liczba dni lub perm', type: 3, required: true },
    { name: 'moderator', description: 'Moderator', type: 3, required: true },
    { name: 'appeal', description: 'Możliwość odwołania (tak/nie)', type: 3, required: true,
      choices: [{ name: 'Tak', value: 'tak' }, { name: 'Nie', value: 'nie' }] }
  ]},
  { name: 'configbaneh', description: 'Ustaw kanały ban-eh', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [
    { name: 'komendy', description: 'Kanał do wpisywania', type: 7, required: true },
    { name: 'logi', description: 'Kanał logów', type: 7, required: true }
  ]},
  { name: 'skargikanal', description: 'Ustaw kanał na skargi', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [
    { name: 'kanal', description: 'Kanał skarg', type: 7, required: true }
  ]},
  { name: 'skarga', description: 'Dodaj skargę na administrację', options: [
    { name: 'komu', description: 'Na kogo', type: 6, required: true },
    { name: 'powod', description: 'Za co', type: 3, required: true }
  ]},
  { name: 'pochwalakanal', description: 'Ustaw kanał na pochwały', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [
    { name: 'kanal', description: 'Kanał pochwał', type: 7, required: true }
  ]},
  { name: 'pochwala', description: 'Dodaj pochwałę', options: [
    { name: 'komu', description: 'Komu daje', type: 6, required: true },
    { name: 'dlaczego', description: 'Dlaczego', type: 3, required: true }
  ]},
  { name: 'karyperrmison', description: 'Dodaj/usuń rolę do ban-eh/ban-dc/mute', options: [
    { name: 'rola', description: 'Rola', type: 8, required: true },
    { name: 'akcja', description: 'add/remove', type: 3, required: true,
      choices: [{ name: 'dodaj', value: 'add' }, { name: 'usuń', value: 'remove' }] }
  ]},
  { name: 'karyperrmisonlist', description: 'Lista ról kary (ban-eh/ban-dc/mute)' },
  { name: 'unkaryperrmision', description: 'Dodaj/usuń rolę do unban/unmute', options: [
    { name: 'rola', description: 'Rola', type: 8, required: true },
    { name: 'akcja', description: 'add/remove', type: 3, required: true,
      choices: [{ name: 'dodaj', value: 'add' }, { name: 'usuń', value: 'remove' }] }
  ]},
  { name: 'unkaryperrmisionlist', description: 'Lista ról do unban/unmute' },
  { name: 'bandckanal', description: 'Kanały dla ban-dc', options: [
    { name: 'komendy', description: 'Kanał komendy', type: 7, required: true },
    { name: 'logi', description: 'Kanał logów', type: 7, required: true }
  ]},
  { name: 'ban-dc', description: 'Ban DC + ID kary', options: [
    { name: 'uzytkownik', description: 'Kogo banujesz', type: 6, required: true },
    { name: 'reason', description: 'Powód', type: 3, required: true },
    { name: 'days', description: 'Dni lub perm', type: 3, required: true },
    { name: 'moderator', description: 'Moderator', type: 3, required: true }
  ]},
  { name: 'mute', description: 'Timeout (mute) + ID kary', options: [
    { name: 'uzytkownik', description: 'Kogo wyciszasz', type: 6, required: true },
    { name: 'reason', description: 'Powód', type: 3, required: true },
    { name: 'czas', description: 'Czas (np. 30m, 2h, 1d)', type: 3, required: true },
    { name: 'moderator', description: 'Moderator', type: 3, required: true }
  ]},
  { name: 'idlist', description: 'ID kar banów/mute DC', options: [
    { name: 'strona', description: 'Numer strony (15 wpisów na stronę)', type: 4, required: false }
  ]},
  { name: 'idsearch', description: 'Szukaj kary po ID', options: [
    { name: 'id', description: 'ID kary (BAN-/MUTE-...)', type: 3, required: true }
  ]},
  { name: 'zmianakanlow', description: 'Dodaj/usuń rolę do zmiany kanałów konfiguracyjnych', options: [
    { name: 'rola', description: 'Rola', type: 8, required: true },
    { name: 'akcja', description: 'add/remove', type: 3, required: true,
      choices: [{ name: 'dodaj', value: 'add' }, { name: 'usuń', value: 'remove' }] }
  ]},
  { name: 'zmianakanlowlist', description: 'Lista ról do zmiany kanałów konfiguracyjnych' },
  { name: 'commandvisibility', description: 'Widoczność komend (poza /skarga)', options: [
    { name: 'akcja', description: 'on/off/list-on/list-off', type: 3, required: true,
      choices: [ { name: 'on', value: 'on' }, { name: 'off', value: 'off' }, { name: 'list-on', value: 'list-on' }, { name: 'list-off', value: 'list-off' } ] },
    { name: 'rola', description: 'Rola (dla on/off)', type: 8, required: false }
  ]},
  { name: 'unbanchannel', description: 'Kanał do nadawania unbanów/unmute DC', options: [
    { name: 'kanal', description: 'Kanał komend unban/unmute', type: 7, required: true }
  ]},
  { name: 'unbandc', description: 'Zdejmij bana DC po ID kary', options: [
    { name: 'id', description: 'ID kary (BAN-...)', type: 3, required: true }
  ]},
  { name: 'unmutedc', description: 'Zdejmij mute (timeout) po ID kary', options: [
    { name: 'id', description: 'ID kary (MUTE-...)', type: 3, required: true }
  ]},
  { name: 'saveserver', description: 'Zapisz backup struktury serwera' },
  { name: 'backup', description: 'Przywróć zapisany backup struktury serwera' },
  { name: 'stworzkanalwybierz', description: 'Wybierz kanał-szablon do auto-tworzenia prywatnych kanałów', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [
    { name: 'kanal', description: 'Kanał wejściowy (1 osoba)', type: 7, required: true }
  ]},
  { name: 'vc-name', description: 'Zmień nazwę swojego kanału', options: [ { name: 'nazwa', description: 'Nowa nazwa kanału', type: 3, required: true } ] },
  { name: 'vc-limit', description: 'Ustaw limit osób w swoim kanale', options: [ { name: 'limit', description: '0 = bez limitu', type: 4, required: true } ] },
  { name: 'vc-kick', description: 'Wyrzuć użytkownika ze swojego kanału', options: [ { name: 'user', description: 'Kogo wyrzucić', type: 6, required: true } ] },
  { name: 'vc-ban', description: 'Zbanuj użytkownika ze swojego kanału', options: [ { name: 'user', description: 'Kogo zbanować', type: 6, required: true } ] },
  { name: 'vc-close', description: 'Usuń swój kanał' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try { await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, GUILD_ID), { body: commands }); console.log('✅ Zarejestrowano komendy'); }
  catch (err) {
    console.error('❌ Rejestracja komend:', err?.rawError ?? err);
    try { await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commands }); console.log('ℹ️ Rejestracja globalna (może potrwać).'); }
    catch (e) { console.error('❌ Rejestracja globalna:', e?.rawError ?? e); }
  }
}

client.on('clientReady', () => console.log(`Zalogowano jako ${client.user.tag}`));

async function createPrivateChannel(member, templateId) {
  const guild = member.guild;
  const template = guild.channels.cache.get(templateId);
  if (!template || template.type !== ChannelType.GuildVoice) return null;
  const channel = await guild.channels.create({
    name: `${member.displayName} channel`,
    type: ChannelType.GuildVoice,
    parent: template.parentId ?? undefined,
    permissionOverwrites: template.permissionOverwrites.cache.toJSON(),
    userLimit: 0,
  });
  const meta = { ownerId: member.id, banned: new Set() };
  tempChannels.set(channel.id, meta);
  setTempMeta(guild.id, channel.id, meta);
  // Wysylamy instrukcje bezposrednio do czatu prywatnego kanalu, jesli Discord/guild to wspiera.
  try {
    const msg = [
      `Komendy dla wlasciciela kanalu ${member.displayName}:`,
      '`/vc-name [nazwa]` – zmień nazwę kanału.',
      '`/vc-limit [liczba]` – limit osób (0 = brak).',
      '`/vc-kick @user` – wyrzuć z kanału.',
      '`/vc-ban @user` – zablokuj dostęp do kanału.',
      '`/vc-close` – usuń kanał.',
      'Dzialaja tylko dla wlasciciela i tylko kiedy jestes na swoim kanale.'
    ].join('\n');
    if (typeof channel.send === 'function') {
      await channel.send({ content: msg });
    } else {
      const textChannel = channel.guild.systemChannel ?? channel.guild.channels.cache.find(c => c.type === ChannelType.GuildText);
      if (textChannel && typeof textChannel.send === 'function') {
        await textChannel.send({ content: `${member} utworzyl prywatny kanal.\n${msg}` });
      }
    }
  } catch {}
  await member.voice.setChannel(channel).catch(() => {});
  return channel;
}

// VC template logic
client.on('voiceStateUpdate', async (oldState, newState) => {
  const gid = newState.guild.id;
  const cfg = ensureGuild(gid);
  // wejście do szablonu
  if (cfg.tempVoiceTemplateId && !oldState.channelId && newState.channelId === cfg.tempVoiceTemplateId) {
    // tylko jeśli kanał szablon ma 1 slot (zalecane) ale nie wymuszamy; i tylko 1 osoba
    if (newState.channel?.members?.size > 1) return;
    await createPrivateChannel(newState.member, cfg.tempVoiceTemplateId);
    return;
  }
  // blokada wejscia dla osob zbanowanych z prywatnego kanalu
  if (newState.channelId) {
    const liveMeta = tempChannels.get(newState.channelId) ?? getTempMeta(gid, newState.channelId);
    if (liveMeta?.banned?.has(newState.id)) {
      await newState.member.voice.disconnect().catch(() => {});
      return;
    }
    if (liveMeta && !tempChannels.has(newState.channelId)) {
      tempChannels.set(newState.channelId, liveMeta);
    }
  }
  // Gdy wlasciciel opuszcza kanal, traci wlasnosc natychmiast.
  if (oldState.channelId) {
    const oldMeta = tempChannels.get(oldState.channelId) ?? getTempMeta(gid, oldState.channelId);
    if (oldMeta?.ownerId === oldState.id && oldState.channelId !== newState.channelId) {
      oldMeta.ownerId = null;
      tempChannels.set(oldState.channelId, oldMeta);
      setTempMeta(gid, oldState.channelId, oldMeta);
    }
  }
  // auto delete
  if (oldState.channelId && tempChannels.has(oldState.channelId)) {
    const ch = oldState.channel;
    if (ch && ch.members.size === 0) {
      tempChannels.delete(ch.id);
      deleteTempMeta(gid, ch.id);
      await ch.delete().catch(() => {});
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const cfg = ensureGuild(interaction.guildId);

    if (!isCommandVisible(interaction.member, cfg, interaction.commandName)) {
      await safeReply(interaction, { content: '⛔ Nie masz dostępu do tej komendy.', flags: 64 });
      return;
    }

    if (['idlist','idsearch'].includes(interaction.commandName) && !interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await safeReply(interaction, { content: '⛔ Tę komendę może używać tylko Administrator.', flags: 64 });
      return;
    }

    if (['saveserver', 'backup'].includes(interaction.commandName) && !isBackupOwner(interaction.user)) {
      await safeReply(interaction, { content: '⛔ Tej komendy może używać tylko Tomala6.', flags: 64 });
      return;
    }

    // widoczność
    if (interaction.commandName === 'commandvisibility') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '⛔ Tylko Administrator może zmieniać widoczność.', flags: 64 });
        return;
      }
      const action = interaction.options.getString('akcja', true);
      const role = interaction.options.getRole('rola');
      if (['on','off'].includes(action) && !role) return interaction.reply({ content: 'Podaj rolę.', flags: 64 });
      if (action === 'on') {
        if (!cfg.visibilityOnRoleIds.includes(role.id)) cfg.visibilityOnRoleIds.push(role.id);
        cfg.visibilityOffRoleIds = cfg.visibilityOffRoleIds.filter(id => id !== role.id);
        saveConfig();
        return interaction.reply({ content: `✅ Rola <@&${role.id}> widzi wszystkie komendy.`, flags: 64 });
      }
      if (action === 'off') {
        if (!cfg.visibilityOffRoleIds.includes(role.id)) cfg.visibilityOffRoleIds.push(role.id);
        cfg.visibilityOnRoleIds = cfg.visibilityOnRoleIds.filter(id => id !== role.id);
        saveConfig();
        return interaction.reply({ content: `✅ Rola <@&${role.id}> widzi tylko /skarga.`, flags: 64 });
      }
      if (action === 'list-on') {
        const list = cfg.visibilityOnRoleIds.length ? cfg.visibilityOnRoleIds.map(id => `<@&${id}>`).join(', ') : 'brak';
        return interaction.reply({ content: `Widzą (on): ${list}`, flags: 64 });
      }
      if (action === 'list-off') {
        const list = cfg.visibilityOffRoleIds.length ? cfg.visibilityOffRoleIds.map(id => `<@&${id}>`).join(', ') : 'brak';
        return interaction.reply({ content: `Nie widzą (off): ${list}`, flags: 64 });
      }
      return;
    }

    // kanały ban-eh
    if (interaction.commandName === 'configbaneh') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator) && !hasAllowedRole(interaction.member, cfg.channelRoleIds)) {
        await interaction.reply({ content: '⛔ Brak uprawnień do zmiany kanałów.', flags: 64 });
        return;
      }
      cfg.commandChannelId = interaction.options.getChannel('komendy', true).id;
      cfg.logChannelId = interaction.options.getChannel('logi', true).id;
      saveConfig();
      await interaction.reply({ content: `✅ /ban-eh: <#${cfg.commandChannelId}> -> <#${cfg.logChannelId}>`, flags: 64 });
      return;
    }

    if (interaction.commandName === 'saveserver') {
      const snapshot = saveServerSnapshot(interaction.guild);
      await safeReply(interaction, {
        content: `✅ Zapisano backup serwera z ${snapshot.roles.length} rolami i ${snapshot.channels.length} kanałami.`,
        flags: 64
      });
      return;
    }

    if (interaction.commandName === 'backup') {
      await interaction.deferReply({ flags: 64 });
      const snapshot = await restoreServerSnapshot(interaction.guild);
      await interaction.editReply(`✅ Przywrócono backup z ${snapshot.savedAt}. Odtworzono strukturę ${snapshot.guildName}.`);
      return;
    }

    // kanał skarg
    if (interaction.commandName === 'skargikanal') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator) && !hasAllowedRole(interaction.member, cfg.channelRoleIds)) {
        await interaction.reply({ content: '⛔ Brak uprawnień do zmiany kanałów.', flags: 64 });
        return;
      }
      cfg.complaintChannelId = interaction.options.getChannel('kanal', true).id;
      saveConfig();
      await interaction.reply({ content: `✅ Kanał skarg: <#${cfg.complaintChannelId}>`, flags: 64 });
      return;
    }

    // kanał pochwał
    if (interaction.commandName === 'pochwalakanal') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator) && !hasAllowedRole(interaction.member, cfg.channelRoleIds)) {
        await interaction.reply({ content: '⛔ Brak uprawnień do zmiany kanałów.', flags: 64 });
        return;
      }
      cfg.praiseChannelId = interaction.options.getChannel('kanal', true).id;
      saveConfig();
      await interaction.reply({ content: `✅ Kanał pochwał: <#${cfg.praiseChannelId}>`, flags: 64 });
      return;
    }

    // kanał ban-dc
    if (interaction.commandName === 'bandckanal') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator) && !hasAllowedRole(interaction.member, cfg.channelRoleIds)) {
        await interaction.reply({ content: '⛔ Brak uprawnień do zmiany kanałów.', flags: 64 });
        return;
      }
      cfg.dcCommandChannelId = interaction.options.getChannel('komendy', true).id;
      cfg.dcLogChannelId = interaction.options.getChannel('logi', true).id;
      saveConfig();
      await interaction.reply({ content: `✅ /ban-dc: <#${cfg.dcCommandChannelId}> -> <#${cfg.dcLogChannelId}>`, flags: 64 });
      return;
    }

    // kanał unban/unmute
    if (interaction.commandName === 'unbanchannel') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator) && !hasAllowedRole(interaction.member, cfg.channelRoleIds)) {
        await interaction.reply({ content: '⛔ Brak uprawnień do zmiany kanałów.', flags: 64 });
        return;
      }
      cfg.unbanChannelId = interaction.options.getChannel('kanal', true).id;
      saveConfig();
      await interaction.reply({ content: `✅ Kanał unban/unmute: <#${cfg.unbanChannelId}>`, flags: 64 });
      return;
    }

    // szablon VC
    if (interaction.commandName === 'stworzkanalwybierz') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '⛔ Tylko Admin może ustawić szablon kanału.', flags: 64 });
        return;
      }
      const ch = interaction.options.getChannel('kanal', true);
      if (ch.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Wybierz kanał głosowy.', flags: 64 });
        return;
      }
      cfg.tempVoiceTemplateId = ch.id;
      saveConfig();
      await interaction.reply({ content: `✅ Ustawiono szablon VC: <#${ch.id}> (wejście 1 os -> prywatny kanał).`, flags: 64 });
      return;
    }

    // role kary
    if (interaction.commandName === 'karyperrmison') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '⛔ Tylko Admin może zarządzać uprawnieniami kary.', flags: 64 });
        return;
      }
      const role = interaction.options.getRole('rola', true);
      const action = interaction.options.getString('akcja', true);
      if (action === 'add') {
        if (!cfg.banRoleIds.includes(role.id)) cfg.banRoleIds.push(role.id);
        await interaction.reply({ content: `✅ Dodano <@&${role.id}> do ban-eh/ban-dc/mute.`, flags: 64 });
      } else {
        cfg.banRoleIds = cfg.banRoleIds.filter(id => id !== role.id);
        await interaction.reply({ content: `✅ Usunięto <@&${role.id}> z ban-eh/ban-dc/mute.`, flags: 64 });
      }
      saveConfig();
      return;
    }
    if (interaction.commandName === 'karyperrmisonlist') {
      const list = cfg.banRoleIds.length ? cfg.banRoleIds.map(id => `<@&${id}>`).join(', ') : 'Brak ról kary.';
      await interaction.reply({ content: list, flags: 64 });
      return;
    }

    // role unban/unmute
    if (interaction.commandName === 'unkaryperrmision') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '⛔ Tylko Admin może zarządzać unban/unmute.', flags: 64 });
        return;
      }
      const role = interaction.options.getRole('rola', true);
      const action = interaction.options.getString('akcja', true);
      if (action === 'add') {
        if (!cfg.unbanRoleIds.includes(role.id)) cfg.unbanRoleIds.push(role.id);
        await interaction.reply({ content: `✅ Dodano <@&${role.id}> do unban/unmute.`, flags: 64 });
      } else {
        cfg.unbanRoleIds = cfg.unbanRoleIds.filter(id => id !== role.id);
        await interaction.reply({ content: `✅ Usunięto <@&${role.id}> z unban/unmute.`, flags: 64 });
      }
      saveConfig();
      return;
    }
    if (interaction.commandName === 'unkaryperrmisionlist') {
      const list = cfg.unbanRoleIds.length ? cfg.unbanRoleIds.map(id => `<@&${id}>`).join(', ') : 'Brak ról unban/unmute.';
      await interaction.reply({ content: list, flags: 64 });
      return;
    }

    if (interaction.commandName === 'zmianakanlow') {
      if (!interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
        await safeReply(interaction, { content: '⛔ Tylko Admin może zarządzać rolami do zmiany kanałów.', flags: 64 });
        return;
      }
      const role = interaction.options.getRole('rola', true);
      const action = interaction.options.getString('akcja', true);
      if (action === 'add') {
        if (!cfg.channelRoleIds.includes(role.id)) cfg.channelRoleIds.push(role.id);
        await safeReply(interaction, { content: `✅ Dodano <@&${role.id}> do zmiany kanałów.`, flags: 64 });
      } else {
        cfg.channelRoleIds = cfg.channelRoleIds.filter(id => id !== role.id);
        await safeReply(interaction, { content: `✅ Usunięto <@&${role.id}> ze zmiany kanałów.`, flags: 64 });
      }
      saveConfig();
      return;
    }

    if (interaction.commandName === 'zmianakanlowlist') {
      const list = cfg.channelRoleIds.length ? cfg.channelRoleIds.map(id => `<@&${id}>`).join(', ') : 'Brak ról do zmiany kanałów.';
      await safeReply(interaction, { content: list, flags: 64 });
      return;
    }

    // skarga
    if (interaction.commandName === 'skarga') {
      if (!cfg.complaintChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanał skarg: /skargikanal', flags: 64 }); return; }
      if (interaction.channelId !== cfg.complaintChannelId) { await interaction.reply({ content: `🔒 Skargi tylko w <#${cfg.complaintChannelId}>.`, flags: 64 }); return; }
      const kto = interaction.user;
      const komu = interaction.options.getUser('komu', true);
      const powod = interaction.options.getString('powod', true);
      const emb = new EmbedBuilder().setColor(Colors.Orange).setTitle('📝 Skarga na administrację')
        .setDescription(`**Kto daje:** ${kto}\n**Komu daje:** ${komu}\n**Za co:** ${powod}`);
      await interaction.reply({ content: `${kto} ${komu}`, embeds: [emb], allowedMentions: { users: [kto.id, komu.id] } });
      return;
    }

    // pochwała
    if (interaction.commandName === 'pochwala') {
      if (!cfg.praiseChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanał pochwał: /pochwalakanal', flags: 64 }); return; }
      if (interaction.channelId !== cfg.praiseChannelId) { await interaction.reply({ content: `🔒 Pochwały tylko w <#${cfg.praiseChannelId}>.`, flags: 64 }); return; }
      const kto = interaction.user;
      const komu = interaction.options.getUser('komu', true);
      const dlaczego = interaction.options.getString('dlaczego', true);
      const emb = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('🌟 Pochwała')
        .setDescription(`**Kto:** ${kto}\n**Komu:** ${komu}\n**Dlaczego:** ${dlaczego}`);
      await interaction.reply({ content: `${kto} ${komu}`, embeds: [emb], allowedMentions: { users: [kto.id, komu.id] } });
      return;
    }

    // VC owner commands
    if (['vc-name','vc-limit','vc-kick','vc-ban','vc-close'].includes(interaction.commandName)) {
      const voice = interaction.member.voice?.channel;
      const meta = voice && (tempChannels.get(voice.id) ?? getTempMeta(interaction.guildId, voice.id));
      if (!voice || !meta || meta.ownerId !== interaction.member.id) {
        await safeReply(interaction, { content: '⛔ To nie jest Twój kanał prywatny.', flags: 64 });
        return;
      }
      if (!tempChannels.has(voice.id)) {
        tempChannels.set(voice.id, meta);
      }
      if (interaction.commandName === 'vc-name') {
        const name = interaction.options.getString('nazwa', true).trim().slice(0, 100);
        if (!name) {
          await safeReply(interaction, { content: 'Podaj poprawną nazwę kanału.', flags: 64 });
          return;
        }
        await voice.setName(name);
        await safeReply(interaction, { content: `✅ Nazwa kanału zmieniona na: ${name}`, flags: 64 });
        return;
      }
      if (interaction.commandName === 'vc-limit') {
        const limit = interaction.options.getInteger('limit', true);
        await voice.setUserLimit(Math.max(0, limit));
        await safeReply(interaction, { content: `✅ Limit ustawiony na ${limit === 0 ? 'brak' : limit}.`, flags: 64 });
        return;
      }
      if (interaction.commandName === 'vc-kick') {
        const user = interaction.options.getUser('user', true);
        const m = voice.members.get(user.id);
        if (!m) { await safeReply(interaction, { content: 'Ten użytkownik nie jest w Twoim kanale.', flags: 64 }); return; }
        await m.voice.disconnect();
        await safeReply(interaction, { content: `✅ Wyrzucono ${user}.`, flags: 64 });
        return;
      }
      if (interaction.commandName === 'vc-ban') {
        const user = interaction.options.getUser('user', true);
        meta.banned = meta.banned || new Set();
        meta.banned.add(user.id);
        const m = voice.members.get(user.id);
        if (m) await m.voice.disconnect();
        tempChannels.set(voice.id, meta);
        setTempMeta(interaction.guildId, voice.id, meta);
        await safeReply(interaction, { content: `✅ Zbanowano ${user} w tym kanale.`, flags: 64 });
        return;
      }
      if (interaction.commandName === 'vc-close') {
        tempChannels.delete(voice.id);
        deleteTempMeta(interaction.guildId, voice.id);
        await voice.delete().catch(() => {});
        await safeReply(interaction, { content: '✅ Kanał usunięty.', flags: 64 });
        return;
      }
    }

    // ban-dc
    if (interaction.commandName === 'ban-dc') {
      if (!cfg.dcCommandChannelId || !cfg.dcLogChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanały: /bandckanal', flags: 64 }); return; }
      if (interaction.channelId !== cfg.dcCommandChannelId) { await interaction.reply({ content: `🔒 /ban-dc tylko w <#${cfg.dcCommandChannelId}>.`, flags: 64 }); return; }
      if (!hasAllowedRole(interaction.member, cfg.banRoleIds)) { await interaction.reply({ content: '⛔ Brak uprawnień do /ban-dc.', flags: 64 }); return; }
      const targetUser = interaction.options.getUser('uzytkownik', true);
      const reason = interaction.options.getString('reason', true);
      const daysInput = interaction.options.getString('days', true);
      const moderator = interaction.options.getString('moderator', true);
      const durationText = formatDuration(daysInput);
      const banId = generateId('BAN');
      try { await interaction.guild.members.ban(targetUser.id, { reason: `${reason} | ID ${banId}` }); }
      catch { await interaction.reply({ content: '❌ Nie mogłem zbanować użytkownika (sprawdź uprawnienia bota).', flags: 64 }); return; }
      cfg.banRecords.unshift({ id: banId, type: 'ban', userId: targetUser.id, reason, duration: durationText, moderator, ts: Date.now() });
      cfg.banRecords = cfg.banRecords.slice(0, 50);
      saveConfig();
      const emb = new EmbedBuilder().setColor(Colors.Orange).setTitle('Zbanowano użytkownika')
        .addFields(
          { name: 'Użytkownik', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Moderator', value: moderator, inline: true },
          { name: 'Powód', value: reason, inline: false },
          { name: 'Czas', value: durationText, inline: true },
          { name: 'ID kary', value: banId, inline: true }
        );
      try { const ch = await interaction.client.channels.fetch(cfg.dcLogChannelId); await ch.send({ embeds: [emb] }); } catch {}
      await interaction.reply({ content: `✅ Zbanowano: <@${targetUser.id}> | ID: ${banId}`, flags: 64 });
      return;
    }

    // mute
    if (interaction.commandName === 'mute') {
      if (!cfg.dcCommandChannelId || !cfg.dcLogChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanały: /bandckanal', flags: 64 }); return; }
      if (interaction.channelId !== cfg.dcCommandChannelId) { await interaction.reply({ content: `🔒 /mute tylko w <#${cfg.dcCommandChannelId}>.`, flags: 64 }); return; }
      if (!hasAllowedRole(interaction.member, cfg.banRoleIds)) { await interaction.reply({ content: '⛔ Brak uprawnień do /mute.', flags: 64 }); return; }
      const targetUser = interaction.options.getUser('uzytkownik', true);
      const reason = interaction.options.getString('reason', true);
      const czas = interaction.options.getString('czas', true);
      const moderator = interaction.options.getString('moderator', true);
      const ms = parseDurationMs(czas);
      if (ms === null) { await interaction.reply({ content: '⚠️ Podaj czas np. 30m, 2h, 1d.', flags: 64 }); return; }
      const muteId = generateId('MUTE');
      const until = new Date(Date.now() + ms).toLocaleString('pl-PL', { dateStyle: 'full', timeStyle: 'short' });
      try { const member = await interaction.guild.members.fetch(targetUser.id); await member.timeout(ms, `${reason} | ID ${muteId}`); }
      catch { await interaction.reply({ content: '❌ Nie mogłem ustawić mute (sprawdź uprawnienia bota).', flags: 64 }); return; }
      cfg.banRecords.unshift({ id: muteId, type: 'mute', userId: targetUser.id, reason, duration: czas, moderator, until, ts: Date.now() });
      cfg.banRecords = cfg.banRecords.slice(0, 50);
      saveConfig();
      const emb = new EmbedBuilder().setColor(Colors.Blue).setTitle('Użytkownik został wyciszony')
        .addFields(
          { name: 'Użytkownik', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Moderator', value: moderator, inline: true },
          { name: 'Powód', value: reason, inline: false },
          { name: 'ID kary', value: muteId, inline: true },
          { name: 'Czas trwania', value: until, inline: true }
        );
      try { const ch = await interaction.client.channels.fetch(cfg.dcLogChannelId); await ch.send({ embeds: [emb] }); } catch {}
      await interaction.reply({ content: `✅ Wyciszono: <@${targetUser.id}> | ID: ${muteId}`, flags: 64 });
      return;
    }

    // idlist
    if (interaction.commandName === 'idlist') {
      const page = interaction.options.getInteger('strona') ?? 1;
      const pageSize = 15;
      const start = (page - 1) * pageSize;
      const slice = cfg.banRecords.slice(start, start + pageSize);
      const lines = slice.map(b => `${b.id} [${b.type === 'mute' ? 'MUTE' : 'BAN'}] | <@${b.userId}> | ${b.duration}${b.until ? ' | Do: ' + b.until : ''} | ${b.reason}`);
      const totalPages = Math.max(1, Math.ceil(cfg.banRecords.length / pageSize));
      await interaction.reply({ content: (lines.join('\n') || 'Brak zarejestrowanych kar.') + `\nStrona ${page}/${totalPages}`, flags: 64 });
      return;
    }

    // idsearch
    if (interaction.commandName === 'idsearch') {
      const id = (interaction.options.getString('id', true) || '').trim().toUpperCase();
      const record = cfg.banRecords.find(r => r.id.toUpperCase() === id);
      if (!record) { await interaction.reply({ content: 'Nie znaleziono kary o podanym ID.', flags: 64 }); return; }
      const type = record.type === 'mute' ? 'MUTE' : 'BAN';
      const until = record.until ? ` | Do: ${record.until}` : '';
      await interaction.reply({ content: `**${record.id}** [${type}] | <@${record.userId}> | ${record.duration}${until}\nPowód: ${record.reason}\nModerator: ${record.moderator || 'brak'}`, flags: 64 });
      return;
    }

    // unban dc
    if (interaction.commandName === 'unbandc') {
      if (!cfg.unbanChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanał: /unbanchannel', flags: 64 }); return; }
      if (interaction.channelId !== cfg.unbanChannelId) { await interaction.reply({ content: `🔒 /unbandc tylko w <#${cfg.unbanChannelId}>.`, flags: 64 }); return; }
      if (!hasAllowedRole(interaction.member, cfg.unbanRoleIds)) { await interaction.reply({ content: '⛔ Brak uprawnień do /unbandc.', flags: 64 }); return; }
      const id = (interaction.options.getString('id', true) || '').trim().toUpperCase();
      const rec = cfg.banRecords.find(r => r.id.toUpperCase() === id && r.type === 'ban');
      if (!rec) { await interaction.reply({ content: 'Nie znaleziono bana o podanym ID.', flags: 64 }); return; }
      try { await interaction.guild.members.unban(rec.userId); }
      catch { await interaction.reply({ content: '❌ Nie mogłem zdjąć bana (sprawdź uprawnienia bota).', flags: 64 }); return; }
      await interaction.reply({ content: `✅ Zdjęto bana (ID: ${rec.id}) z <@${rec.userId}>.`, flags: 64 });
      return;
    }

    // unmute dc
    if (interaction.commandName === 'unmutedc') {
      if (!cfg.unbanChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanał: /unbanchannel', flags: 64 }); return; }
      if (interaction.channelId !== cfg.unbanChannelId) { await interaction.reply({ content: `🔒 /unmutedc tylko w <#${cfg.unbanChannelId}>.`, flags: 64 }); return; }
      if (!hasAllowedRole(interaction.member, cfg.unbanRoleIds)) { await interaction.reply({ content: '⛔ Brak uprawnień do /unmutedc.', flags: 64 }); return; }
      const id = (interaction.options.getString('id', true) || '').trim().toUpperCase();
      const rec = cfg.banRecords.find(r => r.id.toUpperCase() === id && r.type === 'mute');
      if (!rec) { await interaction.reply({ content: 'Nie znaleziono mute o podanym ID.', flags: 64 }); return; }
      try {
        const member = await interaction.guild.members.fetch(rec.userId);
        await member.timeout(null, 'unmute');
      } catch {
        await interaction.reply({ content: '❌ Nie mogłem zdjąć mute (sprawdź uprawnienia bota).', flags: 64 });
        return;
      }
      await interaction.reply({ content: `✅ Zdjęto mute (ID: ${rec.id}) z <@${rec.userId}>.`, flags: 64 });
      return;
    }

    // ban-eh
    if (interaction.commandName === 'ban-eh') {
      if (!cfg.commandChannelId || !cfg.logChannelId) { await interaction.reply({ content: '⚠️ Ustaw kanały: /configBanEH', flags: 64 }); return; }
      if (interaction.channelId !== cfg.commandChannelId) { await interaction.reply({ content: `🔒 /ban-eh tylko w <#${cfg.commandChannelId}>.`, flags: 64 }); return; }
      if (!hasAllowedRole(interaction.member, cfg.banRoleIds)) { await interaction.reply({ content: '⛔ Brak uprawnień do /ban-eh.', flags: 64 }); return; }
      const nick = interaction.options.getString('nick', true);
      const reason = interaction.options.getString('reason', true);
      const daysInput = interaction.options.getString('days', true);
      const moderator = interaction.options.getString('moderator', true);
      const appealText = interaction.options.getString('appeal', true).toLowerCase() === 'tak' ? 'Tak' : 'Nie';
      const durationText = formatDuration(daysInput);
      const embed = new EmbedBuilder()
        .setTitle('\u2002\u2002🚫  BAN NA SERWERZE  🚫\u2002\u2002')
        .setDescription('\u2002\u2002**Fordon RP**\u2002\u2002')
        .setColor(Colors.Red)
        .addFields(
          { name: '👤 Użytkownik', value: nick, inline: false },
          { name: '✅ Status', value: 'Zbanowany przez administrację', inline: false },
          { name: '⚖️ Powód', value: reason, inline: false },
          { name: '⏱️ Czas bana', value: durationText, inline: false },
          { name: '🛡️ Moderator', value: moderator, inline: false },
          { name: '📨 Możliwość odwołania', value: appealText, inline: false },
          { name: 'ℹ️ Informacja', value: 'Ban został nadany zgodnie z regulaminem serwera.', inline: false },
          { name: '📝 Jeśli użytkownik ma możliwość odwołania', value: 'Ma przygotować mądre i szczegółowe wyjaśnienie swojej sprawy. Rozpatrzymy zgłoszenie i podejmiemy decyzję.', inline: false },
          { name: '⚠️ Prośba', value: 'Prosimy wszystkich przestrzegajcie zasady serwera, żeby był porządek i spoko atmosfera na serwerze.', inline: false }
        );
      try {
        const ch = await interaction.client.channels.fetch(cfg.logChannelId);
        await ch.send({ embeds: [embed] });
        await interaction.reply({ content: '✅ Wysłano ogłoszenie o banie.', flags: 64 });
      } catch {
        await interaction.reply({ content: '❌ Nie mogłem wysłać na kanał logów. Sprawdź dostęp.', flags: 64 });
      }
      return;
    }

  } catch (err) {
    console.error('Błąd interakcji:', err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await safeReply(interaction, { content: '❌ Wystąpił błąd (sprawdź logi bota).', flags: 64 });
      }
    } catch {}
  }
});

(async () => {
  try { await registerCommands(); } catch {}
  await client.login(DISCORD_TOKEN);
})();
