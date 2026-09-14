import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the actual inline renderer without adding a browser installation to npm test.
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = html.match(/    function renderContentUrl\(value\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(source, 'admin page must contain the URL renderer');

class Element {
  children = [];
  text = '';
  constructor(tagName) { this.tagName = tagName; }
  set innerHTML(_) { throw new Error('Untrusted configuration must never enter an HTML parser'); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text; }
  replaceChildren(...children) { this.children = children; }
}

function fixture() {
  const container = new Element('div');
  const render = runInNewContext(`${source}\nrenderContentUrl`, {
    URL,
    contentUrlEl: container,
    document: { createElement: (tag) => new Element(tag) },
  });
  return { container, render };
}

test('HTTPS URLs become links with literal text and opener isolation', () => {
  const { container, render } = fixture();
  for (const value of ['https://example.test/', 'https://example.test/?q=a&b=c#fragment']) {
    render(value);
    assert.equal(container.children.length, 1);
    const link = container.children[0];
    assert.equal(link.tagName, 'a');
    assert.equal(link.href, new URL(value).href);
    assert.equal(link.textContent, value);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('markup and attribute injection remain literal text', () => {
  const { container, render } = fixture();
  for (const value of [
    '<img src=x onerror=alert(1)>',
    'https://example.test/\"><img src=x onerror=alert(1)>',
    'https://example.test/\" onclick=\"alert(1)',
  ]) {
    render(value);
    assert.equal(container.textContent, value);
    assert.ok(container.children.every((child) => child.tagName === 'a'));
    for (const link of container.children) {
      assert.equal(link.children.length, 0);
      assert.equal(link.onclick, undefined);
      assert.equal(link.onerror, undefined);
    }
  }
});

test('unsafe schemes, malformed URLs, and empty values remove any previous link', () => {
  const { container, render } = fixture();
  for (const value of [
    'http://example.test/', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\tjavascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd',
    '//example.test/', 'not a URL', '',
  ]) {
    render('https://example.test/previous');
    render(value);
    assert.equal(container.children.length, 0);
    assert.equal(container.textContent, value);
  }
});
