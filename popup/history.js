// Nazar, history page: every popup Nazar handled, newest first, by day and
// then by site, so a multi-step signup reads as one story.

const $ = (id) => document.getElementById(id);

const ANSWERED = new Set(['declined', 'accepted', 'required-only']);

// Groups items by key, keeping first-seen order (newest first here).
function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups];
}

function siteCard(host, entries) {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('a');
  head.className = 'site-title';
  head.href = 'https://' + host;
  head.target = '_blank';
  head.title = 'Open the site, to change a choice in its privacy or consent settings';
  head.textContent = host;
  const list = document.createElement('ul');
  list.className = 'activity-list';
  list.append(...entries.map((entry) => renderActivityItem(entry)));
  card.append(head, list);
  return card;
}

async function render() {
  const { activity = [] } = await chrome.storage.local.get('activity');

  $('empty').hidden = activity.length > 0;
  $('clearBtn').hidden = activity.length === 0;

  const answered = activity.filter((e) => ANSWERED.has(e.decision)).length;
  const sites = new Set(activity.map((e) => e.host)).size;
  if (activity.length > 0) {
    $('summary').textContent =
      `${answered} popup${answered === 1 ? '' : 's'} answered across ${sites} site${sites === 1 ? '' : 's'}.`;
  }

  const day = (entry) => new Date(entry.ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('days').replaceChildren(...groupBy(activity, day).map(([date, entries]) => {
    const section = document.createElement('section');
    const title = document.createElement('div');
    title.className = 'day-title';
    title.textContent = date;
    section.append(title, ...groupBy(entries, (e) => e.host).map(([host, siteEntries]) => siteCard(host, siteEntries)));
    return section;
  }));
}

$('clearBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearActivity' });
  render();
});

render();
