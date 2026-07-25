// Nazar: curated privacy-friendly alternatives, keyed by domain.
// Community-maintained. To add an entry, open a pull request.
// Prefer open source, end-to-end encrypted, or India-built options.
// "in" marks products with Indian founders or teams.

const ALTERNATIVES = {
  'whatsapp.com': [{ name: 'Signal', url: 'https://signal.org', note: 'end-to-end encrypted, nonprofit' }],
  'web.whatsapp.com': [{ name: 'Signal', url: 'https://signal.org', note: 'end-to-end encrypted, nonprofit' }],
  'telegram.org': [{ name: 'Signal', url: 'https://signal.org', note: 'encrypted by default, unlike Telegram' }],
  'messenger.com': [{ name: 'Signal', url: 'https://signal.org', note: 'end-to-end encrypted' }],

  'gmail.com': [
    { name: 'Proton Mail', url: 'https://proton.me/mail', note: 'end-to-end encrypted email' },
    { name: 'Tuta', url: 'https://tuta.com', note: 'encrypted, open source' },
  ],
  'mail.google.com': [{ name: 'Proton Mail', url: 'https://proton.me/mail', note: 'end-to-end encrypted email' }],
  'outlook.com': [{ name: 'Proton Mail', url: 'https://proton.me/mail', note: 'end-to-end encrypted email' }],

  'google.com': [
    { name: 'DuckDuckGo', url: 'https://duckduckgo.com', note: 'no search tracking' },
    { name: 'Brave Search', url: 'https://search.brave.com', note: 'independent index, no profiling' },
  ],
  'photos.google.com': [{ name: 'Ente', url: 'https://ente.io', note: 'encrypted photos, Indian-built, open source', in: true }],
  'drive.google.com': [
    { name: 'Proton Drive', url: 'https://proton.me/drive', note: 'encrypted storage' },
    { name: 'Nextcloud', url: 'https://nextcloud.com', note: 'self-hosted, open source' },
  ],
  'docs.google.com': [{ name: 'CryptPad', url: 'https://cryptpad.org', note: 'encrypted collaborative docs, open source' }],
  'forms.google.com': [{ name: 'Formbricks', url: 'https://formbricks.com', note: 'open source forms' }],
  'calendar.google.com': [{ name: 'Proton Calendar', url: 'https://proton.me/calendar', note: 'encrypted calendar' }],
  'maps.google.com': [{ name: 'Organic Maps', url: 'https://organicmaps.app', note: 'offline, no tracking, open source' }],

  'dropbox.com': [{ name: 'Proton Drive', url: 'https://proton.me/drive', note: 'encrypted storage' }],
  'evernote.com': [{ name: 'Joplin', url: 'https://joplinapp.org', note: 'open source notes with sync' }],
  'notion.so': [
    { name: 'AppFlowy', url: 'https://appflowy.com', note: 'open source Notion alternative' },
    { name: 'Obsidian', url: 'https://obsidian.md', note: 'local-first notes' },
  ],
  'trello.com': [{ name: 'Vikunja', url: 'https://vikunja.io', note: 'open source task boards' }],
  'airtable.com': [{ name: 'NocoDB', url: 'https://nocodb.com', note: 'open source Airtable alternative, Indian-built', in: true }],
  'zapier.com': [{ name: 'n8n', url: 'https://n8n.io', note: 'open source automation' }],
  'calendly.com': [{ name: 'Cal.com', url: 'https://cal.com', note: 'open source scheduling' }],
  'typeform.com': [{ name: 'Formbricks', url: 'https://formbricks.com', note: 'open source forms and surveys' }],
  'surveymonkey.com': [{ name: 'LimeSurvey', url: 'https://limesurvey.org', note: 'open source surveys' }],
  'mailchimp.com': [{ name: 'Listmonk', url: 'https://listmonk.app', note: 'open source newsletters, by Zerodha, Indian-built', in: true }],
  'intercom.com': [{ name: 'Chatwoot', url: 'https://chatwoot.com', note: 'open source support chat, Indian-built', in: true }],
  'zendesk.com': [{ name: 'Chatwoot', url: 'https://chatwoot.com', note: 'open source support chat, Indian-built', in: true }],
  'firebase.google.com': [{ name: 'Appwrite', url: 'https://appwrite.io', note: 'open source backend, Indian founder', in: true }],

  'zoom.us': [{ name: 'Jitsi Meet', url: 'https://meet.jit.si', note: 'open source video calls, no account needed' }],
  'slack.com': [
    { name: 'Element', url: 'https://element.io', note: 'encrypted team chat (Matrix)' },
    { name: 'Mattermost', url: 'https://mattermost.com', note: 'self-hosted team chat' },
  ],
  'loom.com': [{ name: 'Cap', url: 'https://cap.so', note: 'open source screen recording' }],

  'x.com': [
    { name: 'Bluesky', url: 'https://bsky.app', note: 'open protocol' },
    { name: 'Mastodon', url: 'https://joinmastodon.org', note: 'decentralized, no ads' },
  ],
  'twitter.com': [{ name: 'Mastodon', url: 'https://joinmastodon.org', note: 'decentralized, no ads' }],
  'medium.com': [{ name: 'Ghost', url: 'https://ghost.org', note: 'open source publishing' }],
  'linktr.ee': [{ name: 'LittleLink', url: 'https://littlelink.io', note: 'open source link page' }],

  'lastpass.com': [
    { name: 'Bitwarden', url: 'https://bitwarden.com', note: 'open source password manager' },
    { name: 'KeePassXC', url: 'https://keepassxc.org', note: 'offline, open source' },
  ],
  'grammarly.com': [{ name: 'LanguageTool', url: 'https://languagetool.org', note: 'open source grammar checker' }],
  'figma.com': [{ name: 'Penpot', url: 'https://penpot.app', note: 'open source design tool' }],
  'wetransfer.com': [{ name: 'Bitwarden Send', url: 'https://bitwarden.com/products/send', note: 'encrypted file sharing' }],
  'chrome.google.com': [
    { name: 'Firefox', url: 'https://mozilla.org/firefox', note: 'independent, open source browser' },
    { name: 'Brave', url: 'https://brave.com', note: 'blocks trackers by default' },
  ],
};

// Match the current hostname against dataset keys (suffix match handles subdomains)
function findAlternatives(hostname) {
  const host = hostname.replace(/^www\./, '');
  if (ALTERNATIVES[host]) return ALTERNATIVES[host];
  for (const key of Object.keys(ALTERNATIVES)) {
    if (host === key || host.endsWith('.' + key)) return ALTERNATIVES[key];
  }
  return null;
}
