import { EMBED_CSS } from './embed';

/**
 * The browser half of the embed: one script tag a host page drops in, plus a
 * div per widget.
 *
 *   <div data-sessionboard="agenda"></div>
 *   <script src="https://…/embed/embed.js" async></script>
 *
 * Written as a string rather than compiled from a module because it is served
 * as an asset to a page we do not control, so it cannot be part of the app's
 * bundle and cannot assume anything the app provides. Consequences worth
 * knowing about:
 *
 *   - It is not type-checked. `e2e/embed.spec.ts` is the safety net, and it
 *     drives the real script on a real host page rather than asserting on this
 *     source.
 *   - ES5 syntax and no template literals, because this file is itself a
 *     template literal and a nested backtick is a bug waiting to happen.
 *   - Nodes are built with `createElement` and `textContent`, never
 *     `innerHTML`. Speaker bios and talk titles are typed by strangers and this
 *     code runs on somebody else's origin; there is no context where writing
 *     that markup as a string is worth the saving.
 *
 * Each container carries `data-sessionboard-state`: `loading`, `ready`,
 * `closed` (the agenda is not published) or `error`. A host page can style on
 * it, and the end-to-end test waits on it.
 */
export function embedScript(): string {
  return `(function () {
  'use strict';

  var CSS = ${JSON.stringify(EMBED_CSS)};

  var current = document.currentScript;
  if (!current || !current.src) return;
  var cut = current.src.indexOf('/embed/embed.js');
  var ROOT = cut === -1 ? '' : current.src.slice(0, cut);

  var STYLE_ID = 'sessionboard-embed-css';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function link(cls, href, text) {
    var a = el('a', cls, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function note(message) {
    return el('p', 'sb-note', message);
  }

  function creditNode(event) {
    var p = el('p', 'sb-credit', 'Powered by ');
    p.appendChild(link(null, event.url, event.name));
    return p;
  }

  function initials(name) {
    if (!name) return '??';
    var parts = String(name).trim().split(/\\s+/).slice(0, 2);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out += parts[i].charAt(0).toUpperCase();
    }
    return out || '??';
  }

  function excerpt(text, limit) {
    if (!text) return '';
    return text.length <= limit ? text : text.slice(0, limit).replace(/\\s+$/, '') + '\\u2026';
  }

  function renderSpeakers(feed) {
    var wrap = el('div', 'sb-embed');
    if (!feed.published) {
      wrap.appendChild(note('The speaker line-up for ' + feed.event.name + ' is not published yet.'));
      return wrap;
    }
    if (!feed.speakers.length) {
      wrap.appendChild(note('No speaker matches that filter.'));
      return wrap;
    }

    var list = el('ul', 'sb-grid');
    for (var i = 0; i < feed.speakers.length; i++) {
      var speaker = feed.speakers[i];
      var card = el('li', 'sb-card');

      if (speaker.headshotUrl) {
        var img = el('img', 'sb-avatar');
        img.src = speaker.headshotUrl;
        img.alt = '';
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        var placeholder = el('span', 'sb-avatar', initials(speaker.name));
        placeholder.setAttribute('aria-hidden', 'true');
        card.appendChild(placeholder);
      }

      var body = el('div', 'sb-body');
      body.appendChild(link('sb-name', speaker.url, speaker.name || 'Unnamed speaker'));
      body.appendChild(el('p', 'sb-meta', speaker.talks + ' in the programme'));
      if (speaker.bio) body.appendChild(el('p', 'sb-bio', excerpt(speaker.bio, 170)));

      var tags = (speaker.tracks || []).concat((speaker.keywords || []).slice(0, 4));
      if (tags.length) {
        var box = el('div', 'sb-tags');
        for (var t = 0; t < tags.length; t++) box.appendChild(el('span', 'sb-tag', tags[t]));
        body.appendChild(box);
      }

      card.appendChild(body);
      list.appendChild(card);
    }

    wrap.appendChild(list);
    wrap.appendChild(creditNode(feed.event));
    return wrap;
  }

  function renderAgenda(feed) {
    var wrap = el('div', 'sb-embed');
    if (!feed.published) {
      wrap.appendChild(note('The schedule for ' + feed.event.name + ' is not published yet.'));
      return wrap;
    }
    if (!feed.days.length) {
      wrap.appendChild(note('Nothing scheduled matches that filter.'));
      return wrap;
    }

    for (var d = 0; d < feed.days.length; d++) {
      var day = feed.days[d];
      wrap.appendChild(el('h3', 'sb-day', day.label));
      var list = el('ul', 'sb-list');

      for (var e = 0; e < day.entries.length; e++) {
        var entry = day.entries[e];
        var item = el('li', entry.id ? 'sb-item' : 'sb-item sb-break');
        item.appendChild(el('span', 'sb-time', entry.time));

        var body = el('span', 'sb-body');
        if (entry.trackColour) {
          var dot = el('span', 'sb-dot');
          dot.style.background = entry.trackColour;
          body.appendChild(dot);
        }
        body.appendChild(
          entry.url ? link('sb-title', entry.url, entry.title) : el('span', 'sb-title', entry.title)
        );

        var meta = [entry.speaker, entry.room, entry.track, entry.format].filter(Boolean).join(' \\u00b7 ');
        if (meta) body.appendChild(el('p', 'sb-meta', meta));

        item.appendChild(body);
        list.appendChild(item);
      }

      wrap.appendChild(list);
    }

    wrap.appendChild(creditNode(feed.event));
    return wrap;
  }

  var OPTIONS = ['track', 'day', 'q', 'format', 'level', 'room'];

  function feedUrl(name, node) {
    var query = [];
    for (var i = 0; i < OPTIONS.length; i++) {
      var value = node.getAttribute('data-' + OPTIONS[i]);
      if (value) query.push(OPTIONS[i] + '=' + encodeURIComponent(value));
    }
    return ROOT + '/embed/' + name + '.json' + (query.length ? '?' + query.join('&') : '');
  }

  function fail(node, message, detail) {
    node.textContent = '';
    var wrap = el('div', 'sb-embed');
    wrap.appendChild(note(message));
    node.appendChild(wrap);
    node.setAttribute('data-sessionboard-state', 'error');
    if (window.console && detail) window.console.warn('[sessionboard] ' + detail);
  }

  function mount(node) {
    if (node.getAttribute('data-sessionboard-state')) return;
    var name = (node.getAttribute('data-sessionboard') || '').trim();
    var render = name === 'speakers' ? renderSpeakers : name === 'agenda' ? renderAgenda : null;

    if (!render) {
      fail(
        node,
        'Unknown Sessionboard widget "' + name + '". Use data-sessionboard="speakers" or data-sessionboard="agenda".',
        'unknown widget: ' + name
      );
      return;
    }

    node.setAttribute('data-sessionboard-state', 'loading');
    fetch(feedUrl(name, node), { credentials: 'omit' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (feed) {
        node.textContent = '';
        node.appendChild(render(feed));
        node.setAttribute('data-sessionboard-state', feed.published ? 'ready' : 'closed');
      })
      .catch(function (error) {
        fail(node, 'The ' + name + ' could not be loaded right now.', error && error.message);
      });
  }

  function start() {
    ensureStyle();
    var nodes = document.querySelectorAll('[data-sessionboard]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;
}
