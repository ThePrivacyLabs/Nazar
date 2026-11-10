// Nazar, one activity entry rendered as a list row. Shared by the popup
// ("Handled on this page") and the history page, so both read the same.
//
// A row answers "what did I agree to?": the decision, the button the person
// pressed that the popup answered (their own words for what they were
// doing), then the purposes given and refused, when the popup named them.

const ACTIVITY_VIEW = {
  declined: { icon: '✕', verb: 'Declined', cls: 'declined' },
  accepted: { icon: '✓', verb: 'Accepted', cls: 'accepted' },
  'required-only': { icon: '✓', verb: 'Required only', cls: 'required-only' },
  left: { icon: '•', verb: 'Left to you', cls: 'left' },
  flagged: { icon: '!', verb: 'Flagged', cls: 'flagged' },
};

function activityLine(className, text) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

function purposesLine(heading, purposes) {
  const div = document.createElement('div');
  div.className = 'activity-purposes';
  const b = document.createElement('b');
  b.textContent = heading + ': ';
  div.append(b, purposes.join(', '));
  return div;
}

// { showHost } adds the site, for lists that span many sites.
function renderActivityItem(entry, { showHost = false } = {}) {
  const view = ACTIVITY_VIEW[entry.decision] || ACTIVITY_VIEW.left;
  const gave = entry.gave || [];
  const refused = entry.refused || [];
  const named = gave.length > 0 || refused.length > 0;

  const li = document.createElement('li');
  li.className = 'activity-item ' + view.cls;

  const icon = document.createElement('span');
  icon.className = 'activity-icon';
  icon.textContent = view.icon;

  const main = document.createElement('div');
  main.className = 'activity-main';
  const what = document.createElement('div');
  what.className = 'activity-what';
  const verb = document.createElement('b');
  verb.textContent = view.verb;
  what.append(verb, ' ' + (entry.trigger ? `after you clicked "${entry.trigger}"` : entry.label || 'a popup'));
  main.append(what);

  if (gave.length > 0) main.append(purposesLine('Gave', gave));
  if (refused.length > 0) main.append(purposesLine('Refused', refused));

  // The popup's own heading, when the headline used the click instead; the
  // reason, when no purposes explain the decision.
  const meta = [
    showHost ? entry.host : '',
    entry.trigger ? entry.label : '',
    named ? '' : entry.reason,
  ].filter(Boolean).join(' · ');
  if (meta) main.append(activityLine('activity-why', meta));

  const time = document.createElement('time');
  time.className = 'activity-time';
  time.dateTime = new Date(entry.ts).toISOString();
  time.textContent = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  li.append(icon, main, time);
  return li;
}
