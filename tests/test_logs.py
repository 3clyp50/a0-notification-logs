"""Browser tests use only local plugin and Agent Zero assets, never a live instance."""

import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

playwright = pytest.importorskip('playwright.sync_api')
PLUGIN = Path(__file__).resolve().parents[1]
A0 = Path(os.environ.get('A0_ROOT', PLUGIN.parents[2]))
WEBUI = A0 / 'webui'


@pytest.fixture
def browser():
    if not (WEBUI / 'index.css').is_file():
        pytest.skip('Set A0_ROOT to an Agent Zero checkout.')
    with playwright.sync_playwright() as p:
        try:
            instance = p.chromium.launch()
        except playwright.Error as error:
            if "Executable doesn't exist" in str(error):
                pytest.skip('A Playwright Chromium browser is required.')
            raise
        yield instance
        instance.close()


def load(page):
    component = (PLUGIN / 'webui/logs.html').read_text()
    body = component.split('<body>')[1].split('</body>')[0]
    html = '''<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/index.css">
      <link rel="stylesheet" href="/css/modals.css">
      <link rel="stylesheet" href="/css/settings.css">
      <link rel="stylesheet" href="/vendor/google/google-icons.css">
      <link rel="stylesheet" href="/components/messages/action-buttons/simple-action-buttons.css">
      <script type="module">
        import { store } from '/plugins/notification_logs/webui/logs-store.js';
        import * as history from '/plugins/notification_logs/webui/history.js';
        import { registerAlpineMagic } from '/js/confirmClick.js';
        window.logs = store; window.historyAPI = history;
        document.addEventListener('alpine:init', () => {
          registerAlpineMagic();
          Alpine.directive('create', (_el, {expression}, {evaluateLater}) => evaluateLater(expression)());
          Alpine.directive('destroy', (_el, {expression}, {evaluateLater,cleanup}) => cleanup(() => evaluateLater(expression)()));
        });
        await import('/vendor/alpine/alpine.min.js');
      </script></head><body><div class="modal show"><div class="modal-inner"><div class="modal-scroll"><div class="modal-bd">''' + body + '</div></div></div></div></body></html>'

    def serve(route):
        path = urlparse(route.request.url).path
        if path == '/':
            route.fulfill(content_type='text/html', body=html)
        elif path == '/js/modals.js':
            route.fulfill(content_type='text/javascript', body='export async function openModal() {}')
        elif path == '/components/notifications/notification-store.js':
            route.fulfill(content_type='text/javascript', body='''
              export const store = { addFrontendToastOnly(...args) {
                (window.warnings ??= []).push(args);
                logs.capture({notification: {group:args[4]},source:'frontend'});
              }};
            ''')
        else:
            asset = PLUGIN / path.removeprefix('/plugins/notification_logs/') if path.startswith('/plugins/notification_logs/') else WEBUI / path.lstrip('/')
            route.fulfill(path=asset, content_type=mimetypes.guess_type(asset)[0])
    page.route('**/*', serve)
    page.goto('https://logs.test/')
    page.wait_for_function('window.logs && window.Alpine && !logs.loading')


def capture(page, id='one', message='<b>Failure &amp; details</b><br>LAST LINE', type='error'):
    page.evaluate(r'''async ({id,message,type}) => {
      await logs.capture({source:'backend',notification:{id,title:'Test error',message,detail:'<pre>Detail line 1\nDetail line 2</pre>',type,timestamp:'2026-10-29T10:00:00.000Z'}});
      await logs.refresh();
    }''', dict(id=id,message=message,type=type))


@pytest.mark.parametrize('width', [1100, 390])
def test_persistence_safe_rendering_search_copy_and_clear(browser, width):
    context = browser.new_context(viewport={'width':width,'height':800})
    page = context.new_page()
    load(page)
    capture(page, message='<img src="https://unexpected.test/tracker" onerror="window.pwned=true"><script>window.pwned=true</script><b>Failure &amp; details</b><br>' + 'Traceback line<br>'*100 + 'LAST LINE')
    capture(page, id='two', message='Finished', type='success')
    assert page.evaluate('window.pwned') is None
    assert page.locator('img').count() == 0
    assert page.evaluate('logs.entries.length') == 2
    page.get_by_label('Severity', exact=True).select_option('error')
    playwright.expect(page.locator('details')).to_have_count(1)
    page.locator('summary').click()
    playwright.expect(page.get_by_role('button', name='Copy', exact=True)).to_be_visible()
    page.evaluate('() => { navigator.clipboard.writeText = async text => { window.copied = text; }; }')
    page.get_by_role('button', name='Copy', exact=True).click()
    copied = page.evaluate('window.copied')
    assert 'Failure & details' in copied and 'LAST LINE' in copied and 'Detail line 2' in copied
    assert '<script>' not in copied and '<b>' not in copied
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.get_by_label('Search logs').fill('not present')
    playwright.expect(page.get_by_text('No matches', exact=True)).to_be_visible()
    page.reload()
    page.wait_for_function('window.logs && logs.entries.length === 2')
    capture(page)
    assert page.evaluate('logs.entries.length') == 2
    second = context.new_page()
    load(second)
    capture(second)
    assert second.evaluate('logs.entries.length') == 2
    clear = page.get_by_role('button', name='Clear All', exact=True)
    clear.click()
    assert page.evaluate('logs.entries.length') == 2
    page.get_by_role('button', name='Confirm', exact=True).click()
    playwright.expect(page.get_by_text('No logs', exact=True)).to_be_visible()
    second.wait_for_function('logs.entries.length === 0')
    capture(second)
    assert second.evaluate('logs.entries.length') == 0
    # A new server event survives Clear even if the server clock is behind the browser.
    second.evaluate('''async () => {
      await logs.capture({source:'backend', notification:{id:'new',title:'New error',message:'new',type:'error',timestamp:'2026-10-29T10:00:01.000Z'}});
      await logs.refresh();
    }''')
    assert second.evaluate('logs.entries.length') == 1
    context.close()


def test_retention_and_frontend_storage_failure(browser):
    page = browser.new_page()
    load(page)
    page.evaluate('''async () => {
      const time = Date.now();
      await Promise.all(Array.from({length:1005}, (_,i) => historyAPI.saveRecord({id:String(i),time:time+i,source:'backend',type:'info',title:'Entry',message:'message',detail:''})));
      await logs.refresh();
    }''')
    assert page.evaluate('logs.entries.length') == 1000
    assert page.evaluate('logs.entries[0].id') == '1004'
    page.close()
    page = browser.new_page()
    page.add_init_script("Object.defineProperty(window, 'indexedDB', {value: {open() {throw new Error('Storage denied')}}});")
    load(page)
    page.evaluate('''async () => {
      await logs.capture({source:'frontend',notification:{id:'offline',title:'Connection lost',message:'Failed to fetch',type:'error'}});
      await logs.refresh();
    }''')
    assert page.evaluate('logs.entries[0].message') == 'Failed to fetch'
    assert page.evaluate('window.warnings.length') == 1
    page.close()
