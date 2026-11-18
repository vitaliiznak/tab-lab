"""Browser smoke for guest isolation and the DuckDB lab.

Run with the static site's base URL, including its project path:
    python3 qa/isolation.py http://127.0.0.1:4173/tab-lab/
"""
import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urljoin

import browser as qa


def text_of(selector):
    return qa.val(f'document.querySelector({json.dumps(selector)})?.textContent?.trim() ?? ""')


def click_named(selector):
    label = qa.val(f'(() => {{const b=document.querySelector({json.dumps(selector)});return b.getAttribute("aria-label")||b.textContent.trim()}})()')
    qa.click(label)


def correct_width():
    dimensions = qa.val('({width:innerWidth,content:document.documentElement.scrollWidth})')
    assert dimensions["content"] <= dimensions["width"], dimensions


def wait_amount(selector, expected, timeout=75):
    selector = json.dumps(selector)
    qa.wait(f'Number((document.querySelector({selector})?.textContent || "").replace(/[^0-9]/g, "")) === {expected}',timeout)


def check_proof():
    qa.wait('document.querySelector("#guest-proof")?.textContent.includes("aarch64")',30)
    proof = text_of('#guest-proof')
    assert re.search(r'Linux|kernel',proof,re.I) and 'aarch64' in proof, proof
    assert {'dummy0', 'lo'} <= set(proof.splitlines()), proof
    assert 'unreachable' in proof.lower(), proof
    print(proof, flush=True)
    return proof


def check_workbench():
    qa.cli('click', qa.ref('generic', 'Run your own SQL'))
    for sql, expected, success in (
        ('SELECT 7 AS answer;', 'answer\n7', True),
        ('SELECT * FROM absent_demo_table;', 'absent_demo_table', False),
        ('SELECT count(*) AS days FROM daily;', 'days\n167', True),
    ):
        qa.cli('fill', qa.ref('textbox', 'Query the guest database'), sql)
        qa.click('Run SQL')
        target = '#custom-result' if success else '#custom-status'
        qa.wait(f'document.querySelector({json.dumps(target)}).textContent.includes({json.dumps(expected)})', 20)
        if not success:
            assert qa.val('document.querySelector("#custom-result").hidden')
    qa.cli('click', qa.ref('generic', 'Run your own SQL'))


def check_data(base, capture=True):
    qa.visit(urljoin(base,'data/'))
    wait_amount('#day-passages',568)
    assert '96' in text_of('#day-intervals') and '15' in text_of('#day-zeros')
    days = qa.val('Array.from(document.querySelectorAll("#bike-bars button"), x=>x.getAttribute("aria-label")||x.textContent.trim())')
    assert len(days)==17, days
    # The fourth day in the displayed July 26–August 11 calendar is July 29.
    qa.click(days[3])
    assert '29' in text_of('#selected-day')
    missing = text_of('#day-passages')
    assert not re.search(r'\d',missing), missing
    qa.cli('select',qa.ref('combobox','Bike counter'),'5')
    # Some switches reset the selected day. Inspect July 29 again.
    qa.wait('!document.querySelector("#bike-site").disabled && document.querySelector("#bike-site").value==="5"')
    day = qa.val('document.querySelectorAll("#bike-bars button")[3].getAttribute("aria-label")')
    qa.click(day)
    wait_amount('#day-passages',742)
    assert '96' in text_of('#day-intervals')

    qa.click('Parquet row groups')
    click_named('#build-parquet')
    wait_amount('#parquet-watts',8490000)
    assert '10,000' in text_of('#parquet-count') or '10000' in text_of('#parquet-count')
    groups = qa.val('Array.from(document.querySelectorAll("#parquet-groups .group-label span"),e=>e.textContent)')
    assert any(re.search(r'62\s*/\s*62',g) for g in groups) and any(re.search(r'\b2\s*/\s*62',g) for g in groups), groups
    if capture:
        qa.screenshot('data')
    qa.cli('select',qa.ref('combobox','Station'),'99')
    wait_amount('#parquet-watts',8330000)

    check_workbench()

    # Read the raw sample with the guest executable, independently of the page's queries.
    qa.cli('click',qa.ref('textbox','Terminal input'))
    qa.cli('type',"""duckdb -csv -noheader :memory: "SELECT 'QA_PASS_' || CAST(sum(bike_in + bike_out) AS VARCHAR) FROM read_csv_auto('/opt/lab/daily.csv') WHERE site_id=10 AND day=DATE '2011-07-28';" """.strip())
    qa.cli('press','Enter')
    qa.wait('tabLab.output.includes("QA_PASS_568")',25)
    click_named('#inspect-guest')
    check_proof()
    qa.check_console()

    qa.cli('resize','390','844')
    correct_width()
    # Real narrow-layout controls must still work with a running guest.
    qa.click('Zürich bike counters')
    qa.cli('select',qa.ref('combobox','Bike counter'),'10')
    qa.wait('!document.querySelector("#bike-site").disabled')
    day = qa.val('document.querySelectorAll("#bike-bars button")[2].getAttribute("aria-label")')
    qa.click(day)
    wait_amount('#day-passages',568)
    if capture: qa.screenshot('data-mobile')
    qa.cli('goto',base)
    correct_width()
    assert qa.val('!!Array.from(document.links).find(x=>x.href.includes("/cuda/?inspect=1"))')
    if capture: qa.screenshot('home-mobile')
    qa.cli('resize','1280','800')

def guest_command(command, expected):
    qa.cli('click', qa.ref('textbox', 'Terminal input'))
    qa.cli('type', command)
    qa.cli('press', 'Enter')
    qa.wait(f'tabLab.output.includes({json.dumps(expected)})', 30)


def check_code(base):
    qa.visit(urljoin(base, 'cuda/?inspect=1'))
    first = check_proof()
    boot_id = r'\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b'
    assert '/tmp/tab-lab-marker' in first.splitlines(), first
    original_id = re.search(boot_id, first).group()
    label = text_of('#guest-compare a')
    qa.cli('click', qa.ref('link', label))
    try:
        qa.cli('tab-select', '1')
        second = check_proof()
        assert 'No such file' in second and original_id != re.search(boot_id, second).group(), second
    finally:
        qa.cli('tab-close', '1')
        qa.cli('tab-select', '0')
    guest_command("test -f /tmp/tab-lab-marker && echo QA_''MARKER_PRESENT", 'QA_MARKER_PRESENT')
    qa.click('vecadd')
    qa.wait('tabLab.output.includes("errors=0 c[12345]=30862.5")')
    qa.check_console()
    qa.visit(urljoin(base, 'cuda/?demo=tunnel'))
    qa.wait('tabLab.output.includes("▀")', 30)
    qa.wait(r'tabLab.output.includes("\x1b[?25h")', 90)
    guest_command("echo QA_''TUNNEL_FINISHED", 'QA_TUNNEL_FINISHED')
    qa.check_console()
    qa.visit(urljoin(base,'rust/?cpus=4'))
    click_named('#inspect-guest')
    check_proof()
    result = qa.action('Run',240)
    assert result['exitCode']=='0' and 'Squares: [1, 4, 9, 16, 25, 36]' in qa.latest_run(), result
    qa.check_console()


def main():
    if len(sys.argv)!=2: raise SystemExit(__doc__)
    base = sys.argv[1].rstrip('/')+'/'
    qa.SESSION='tab-isolation'
    qa.OUT=qa.ROOT/'output/playwright/isolation'
    qa.OUT.mkdir(parents=True,exist_ok=True)
    config=json.loads((qa.ROOT/'qa/chromium.json').read_text())
    config['outputDir']=str(qa.OUT/'session')
    try:
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(config,f); f.flush()
            qa.cli('open','about:blank','--config='+f.name)
        check_data(base)
        check_code(base)
    finally:
        qa.cli('close',ok=False)


if __name__=='__main__':
    main()
