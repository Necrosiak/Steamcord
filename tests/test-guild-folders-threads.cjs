// #101 dossiers de serveurs et #100 fils/forums : logique frontend partagée
// et opérations du client Vesktop, exécutées hors Discord avec des stores simulés.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadFolders() {
  const exports = {};
  const react = { useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
  const src = ts.transpileModule(fs.readFileSync('src/guildFolders.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(src, { exports, require: (n) => n === 'react' ? react : n === '@decky/api' ? { call: async () => [] } : {} });
  return exports;
}

const client = fs.readFileSync('defaults/steamcord_client.js', 'utf8');
function slice(from, to) {
  const a = client.indexOf(from); const b = client.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `bloc introuvable : ${from}`);
  return client.slice(a, b);
}
const helpers = slice('// ── Dossiers de serveurs (#101)', '// ── Mapping message Discord');

async function exec(name, nextCase, opts) {
  const body = slice(`case "${name}":`, `case "${nextCase}":`);
  const window = {};
  const Vencord = { Webpack: { Common: { ...(opts.common || {}), RestAPI: { ...((opts.common || {}).RestAPI || {}), get: opts.rest || (async () => { throw Error('no'); }) } }, findStore: (n) => (opts.stores || {})[n] } };
  const ctx = { window, Vencord, data: opts.data || {}, console };
  const code = helpers + `\nvar result;\n(async () => { switch (${JSON.stringify(name)}) { ${body} } return result; })()`;
  // Objets du contexte vm → objets de ce realm, pour deepStrictEqual.
  const out = await vm.runInNewContext(code, ctx);
  return out === undefined ? out : JSON.parse(JSON.stringify(out));
}

test('groupByFolder regroupe à la place du premier membre et garde les index', () => {
  const { groupByFolder } = loadFolders();
  const f = { id: '9', name: 'News', color: 0xff0000 };
  const list = [{ id: 'a' }, { id: 'b', folder: f }, { id: 'c' }, { id: 'd', folder: f }, { id: 'e', folder: null }];
  const out = JSON.parse(JSON.stringify(groupByFolder(list)));
  assert.deepEqual(out.map((e) => e.kind), ['guild', 'folder', 'guild', 'guild']);
  assert.deepEqual(out[1].items.map((it) => [it.guild.id, it.index]), [['b', 1], ['d', 3]]);
  assert.equal(out[2].index, 2);
});

test('un dossier dont un seul serveur est affiché redevient un serveur simple', () => {
  const { groupByFolder } = loadFolders();
  const f = { id: '9', name: null, color: null };
  const out = JSON.parse(JSON.stringify(groupByFolder([{ id: 'a', folder: f }, { id: 'b' }])));
  assert.deepEqual(out.map((e) => [e.kind, e.guild && e.guild.id, e.index]), [['guild', 'a', 0], ['guild', 'b', 1]]);
});

test('nom et couleur de dossier', () => {
  const { folderLabel, folderColor } = loadFolders();
  assert.equal(folderLabel({ id: '1', name: 'Jeux', color: null }, []), 'Jeux');
  assert.equal(folderLabel({ id: '1', name: null, color: null }, [{ name: 'A' }, { name: 'B' }]), 'A, B');
  assert.equal(folderLabel({ id: '1', name: '', color: null }, [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]), 'A, B, C…');
  assert.equal(folderColor({ id: '1', name: null, color: 0x00ff00 }), '#00ff00');
  assert.equal(folderColor({ id: '1', name: null, color: 0x0000aa }), '#0000aa');
  assert.equal(folderColor({ id: '1', name: null, color: null }), '#5865f2');
});

const guildStores = (getAllThreadsForParent) => ({
  common: {
    GuildStore: { getGuilds: () => ({ g1: { id: 'g1', name: 'Un', icon: null }, g2: { id: 'g2', name: 'Deux', icon: 'x' } }) },
    ChannelStore: { getAllThreadsForParent },
  },
  stores: {
    SortedGuildStore: {
      getFlattenedGuildIds: () => ['g1', 'g2'],
      getGuildFolders: () => [{ guildIds: ['g1'] }, { folderId: 77, folderName: 'Veille', folderColor: 255, guildIds: ['g2'] }],
    },
    GuildChannelStore: {
      getChannels: () => ({ SELECTABLE: [
        { channel: { id: 'c1', name: 'general', type: 0 } },
        { channel: { id: 'c2', name: 'aide', type: 15 } },
        { channel: { id: 'c3', name: 'cat', type: 4 } },
      ] }),
    },
  },
});

test('$get_text_channels : dossiers, forums et fils actifs connus', async () => {
  const threads = { c1: [
    { id: '100', name: 'vieux', parent_id: 'c1', lastMessageId: '150' },
    { id: '101', name: 'récent', parent_id: 'c1', lastMessageId: '1000' },
    { id: '102', name: 'archivé', parent_id: 'c1', threadMetadata: { archived: true } },
  ] };
  const st = guildStores((p) => threads[p] || []);
  const res = await exec('$get_text_channels', '$get_threads', { common: st.common, stores: st.stores });
  assert.equal(res[0].folder, null, 'serveur hors dossier');
  assert.deepEqual(res[1].folder, { id: '77', name: 'Veille', color: 255 });
  const chans = res[0].channels;
  assert.deepEqual(chans.map((c) => [c.id, c.type]), [['c1', 0], ['c2', 15]]);
  assert.deepEqual(chans[0].threads.map((t) => t.name), ['récent', 'vieux']);
  assert.equal(chans[1].threads, undefined, 'un forum se charge à la demande');
});

test('$get_text_channels sans getGuildFolders ni threads : liste plate comme avant', async () => {
  const st = guildStores(undefined);
  delete st.common.ChannelStore.getAllThreadsForParent;
  delete st.stores.SortedGuildStore.getGuildFolders;
  const res = await exec('$get_text_channels', '$get_threads', { common: st.common, stores: st.stores });
  assert.equal(res.length, 2);
  assert.ok(res.every((g) => g.folder === null));
  assert.deepEqual(res[0].channels[0].threads, []);
});

test('$get_threads : première page = store + recherche + nos privés archivés, triés par activité', async () => {
  const urls = [];
  const rest = async ({ url }) => {
    urls.push(url);
    if (url.includes('/threads/search')) return { body: { has_more: true, threads: [
      { id: '5', name: 'dup', last_message_id: '9' },
      { id: '6', name: 'actif', last_message_id: '12345678901234567890', message_count: 4 },
      { id: '7', name: 'ancien', last_message_id: '99', thread_metadata: { archived: true } },
    ] } };
    if (url.includes('/users/@me/threads/archived/private')) return { body: { threads: [{ id: '8', name: 'privé', last_message_id: '50', thread_metadata: { archived: true } }] } };
    throw Error('inattendu ' + url);
  };
  const res = await exec('$get_threads', '$create_thread', { data: { id: '42' }, rest,
    common: { ChannelStore: { getAllThreadsForParent: () => [{ id: '5', name: 'dup-store', lastMessageId: '9' }] } } });
  assert.deepEqual(res.threads.map((t) => t.name), ['actif', 'ancien', 'privé', 'dup-store']);
  assert.equal(res.threads[0].count, 4);
  assert.equal(res.threads[1].archived, true);
  assert.equal(res.has_more, true);
  assert.equal(res.next, 3);
  assert.ok(urls[0].startsWith('/channels/42/threads/search?sort_by=last_message_time') && urls[0].endsWith('offset=0'));
  assert.ok(!urls.some((u) => u.includes('archived/public')), 'archives publiques seulement en secours');
});

test('$get_threads : page suivante = recherche seule, à partir de offset', async () => {
  const urls = [];
  const res = await exec('$get_threads', '$create_thread', { data: { id: '42', offset: 25 },
    common: { ChannelStore: { getAllThreadsForParent: () => [{ id: '1', name: 'store' }] } },
    rest: async ({ url }) => { urls.push(url); return { body: { has_more: false, threads: [{ id: '30', name: 'p2', last_message_id: '30' }] } }; } });
  assert.deepEqual(urls, ['/channels/42/threads/search?sort_by=last_message_time&sort_order=desc&limit=25&offset=25']);
  assert.deepEqual(res, { threads: [{ id: '30', name: 'p2', parent_id: '', archived: false, count: 0, last: '30', tags: [] }], has_more: false, next: 26, total: null });
});

test('$get_threads : recherche refusée → archives publiques ; tout refusé → erreur', async () => {
  const partial = await exec('$get_threads', '$create_thread', { data: { id: '42' },
    rest: async ({ url }) => { if (url.includes('search')) throw Error('403'); if (url.includes('public')) return { body: { threads: [{ id: '3', name: 'pub' }] } }; return { body: { threads: [] } }; } });
  assert.deepEqual(partial.threads.map((t) => t.name), ['pub']);
  assert.equal(partial.has_more, false);
  await assert.rejects(exec('$get_threads', '$create_thread', { data: { id: '42' } }), /threads_unavailable/);
  await assert.rejects(exec('$get_threads', '$create_thread', { data: { id: '42', offset: 25 } }), /threads_unavailable/);
  await assert.rejects(exec('$get_threads', '$create_thread', { data: { id: '../x' } }), /bad_channel/);
});

const forumChannel = { id: '42', type: 15, flags: 16, defaultAutoArchiveDuration: 4320, availableTags: [
  { id: '1', name: 'Bug', emojiName: '🐞' }, { id: '2', name: 'Annonce', moderated: true },
] };
const perms = (granted) => ({ can: (bit) => granted.includes(bit) });

test('$get_threads : recherche par titre et par tags, sans fusion du store', async () => {
  const urls = [];
  const res = await exec('$get_threads', '$create_thread', { data: { id: '42', name: '  door ', tags: ['1', 'x', '2'] },
    common: { ChannelStore: { getChannel: () => forumChannel, getAllThreadsForParent: () => [{ id: '9', name: 'store' }] }, PermissionStore: perms([1n << 11n]) },
    rest: async ({ url }) => { urls.push(url); return { body: { has_more: false, total_results: 2, threads: [
      { id: '20', name: 'Door A', last_message_id: '1', applied_tags: ['1'] }, { id: '21', name: 'Door B', last_message_id: '5' }] } }; } });
  assert.equal(urls.length, 1, 'ni store ni privés quand on filtre');
  assert.equal(urls[0], '/channels/42/threads/search?sort_by=relevance&sort_order=desc&limit=25&offset=0&name=door&tag=1&tag=2&tag_setting=match_some');
  assert.deepEqual(res.threads.map((t) => t.name), ['Door A', 'Door B'], 'ordre de pertinence conservé');
  assert.deepEqual(res.threads[0].tags, ['1']);
  assert.equal(res.total, 2);
  assert.deepEqual(res.parent, { kind: 'forum', can_create: true, require_tag: true, tags: [{ id: '1', name: 'Bug', emoji: '🐞' }], auto_archive: 4320 },
    'tag modéré retiré sans MANAGE_THREADS');
});

test('$create_thread : publication de forum (titre, message, tags autorisés)', async () => {
  const posts = [];
  const common = { ChannelStore: { getChannel: () => forumChannel }, PermissionStore: perms([1n << 11n]),
    RestAPI: { post: async (req) => { posts.push(JSON.parse(JSON.stringify(req))); return { body: { id: '77', name: req.body.name, applied_tags: req.body.applied_tags } }; } } };
  const res = await exec('$create_thread', '$get_messages', { data: { id: '42', name: ' Salut ', content: ' corps ', tags: ['1', '2', '999'] }, common });
  assert.deepEqual(posts, [{ url: '/channels/42/threads?use_nested_fields=true',
    body: { name: 'Salut', auto_archive_duration: 4320, applied_tags: ['1'], message: { content: 'corps' } } }]);
  assert.equal(res.id, '77');
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '42', name: 'x', content: '' }, common }), /thread_need_message/);
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '42', name: 'x', content: 'y', tags: ['2'] }, common }), /thread_need_tag/);
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '42', name: '', content: 'y' }, common }), /thread_bad_name/);
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '42', name: 'x'.repeat(101), content: 'y' }, common }), /thread_bad_name/);
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '42', name: 'x', content: 'y', tags: ['1'] },
    common: { ...common, PermissionStore: perms([]) } }), /thread_not_allowed/);
  assert.equal(posts.length, 1, 'aucune requête quand la saisie est refusée');
});

test('$create_thread : fil de salon texte puis premier message, fil d’annonces pour un salon type 5', async () => {
  for (const [type, threadType] of [[0, 11], [5, 10]]) {
    const posts = [];
    const common = { ChannelStore: { getChannel: () => ({ id: '50', type }) }, PermissionStore: perms([1n << 35n]),
      RestAPI: { post: async (req) => { posts.push(JSON.parse(JSON.stringify(req))); return { body: req.url.endsWith('/threads') ? { id: '88', name: req.body.name } : {} }; } } };
    await exec('$create_thread', '$get_messages', { data: { id: '50', name: 'Sujet', content: 'Bonjour' }, common });
    assert.deepEqual(posts, [
      { url: '/channels/50/threads', body: { name: 'Sujet', type: threadType, auto_archive_duration: 1440 } },
      { url: '/channels/88/messages', body: { content: 'Bonjour' } },
    ]);
  }
  const none = [];
  await exec('$create_thread', '$get_messages', { data: { id: '50', name: 'Sujet' },
    common: { ChannelStore: { getChannel: () => ({ id: '50', type: 0 }) }, RestAPI: { post: async (req) => { none.push(req.url); return { body: { id: '89' } }; } } } });
  assert.deepEqual(none, ['/channels/50/threads'], 'sans message, le fil seul');
  await assert.rejects(exec('$create_thread', '$get_messages', { data: { id: '60', name: 'x', content: 'y' },
    common: { ChannelStore: { getChannel: () => ({ id: '60', type: 16 }) } } }), /thread_not_allowed/, 'salon média');
});
