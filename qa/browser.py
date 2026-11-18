"""Check the static deployment with one named, headless Playwright CLI session.

Run from the repository root, e.g. python3 qa/browser.py http://localhost:4173/ cuda
The CUDA and Rust tests click the same controls as visitors. Terminal assertions
use the decoded bytes from the live guest. The GPU-disabled pass tests capability
detection with Chromium GPU acceleration and software fallback disabled.
"""
from pathlib import Path
from urllib.parse import urljoin
import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('TAB_LAB_QA_OUT', ROOT / 'output' / 'playwright'))
SESSION = 'tab-lab'
CLI = shlex.split(os.environ.get('PWCLI', 'npx --yes --package @playwright/cli playwright-cli'))
MEASUREMENTS = []
CURRENT_URL = ''


def cli(*args, ok=True):
    result = subprocess.run(CLI + ['--session', SESSION, *args], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = result.stdout
    if ok and (result.returncode or '### Error' in out):
        raise RuntimeError(out[-4000:])
    return out


def val(js):
    out = cli('eval', js)
    match = re.search(r'### Result\s*\n(.*?)\n###', out, re.S)
    if not match:
        raise ValueError(out[-1500:])
    return json.loads(match[1])


def wait(js, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if val(js):
            return
        time.sleep(0.4)
    raise TimeoutError(f'{js}: {val("window.tabLab?.output?.slice(-1000) ?? document.body.innerText.slice(-1000)")}')


def ref(role, label):
    result = cli('snapshot')
    path = re.search(r'\[Snapshot\]\((.*?)\)', result)
    snapshot = (ROOT / path[1]).read_text() if path else result
    match = re.search(r'\b' + role + r' "' + re.escape(label) + r'"[^\n]*?\[ref=((?:f\d+)?e\d+)\]', snapshot, re.I)
    if not match:
        raise RuntimeError('Missing ' + role + ' "' + label + '" in\n' + snapshot[:3500])
    return match[1]


def click(label):
    cli('click', ref('button', label))


def visit(url):
    global CURRENT_URL
    CURRENT_URL = url
    cli('goto', url)
    wait('Boolean(window.tabLab?.ready) || document.querySelector("#status")?.textContent==="Boot failed"', 150)
    assert val('Boolean(window.tabLab?.ready)'), val('tabLab.output.slice(-1800)')
    metadata = val("""async () => {
      let info = null;
      if(tabLab.gpu) {
        const adapter = await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
        if(adapter) {
          const i=adapter.info;
          info={vendor:i.vendor,architecture:i.architecture,device:i.device,
            description:i.description,fallback:i.isFallbackAdapter ?? null,backend:i.backend ?? null};
        }
      }
      return {browser:navigator.userAgent, adapter:info, bootMs:tabLab.bootMs,
        cpus:tabLab.cpus, memoryMiB:tabLab.memoryMiB, isolated:crossOriginIsolated};
    }""")
    print(f'Booted {url}: {metadata}', flush=True)
    with (OUT / 'browser.jsonl').open('a') as f:
        f.write(json.dumps(dict(metadata,path=url.split("://",1)[-1].split("/",1)[-1])) + '\n')


def screenshot(name):
    cli('screenshot', '--filename=' + str(OUT / (name + '.png')))


def check_console():
    log = cli('console', 'error')
    path = re.search(r'\]\(([^)]+\.log)\)', log)
    if path and (ROOT / path[1]).exists():
        log = (ROOT / path[1]).read_text()
    if re.search(r'\[ERROR\]|\[error\]|Error: |Errors: [1-9]', log):
        raise RuntimeError('Browser console reported errors:\n' + log[:2000])


def cuda(base, unavailable=False):
    visit(urljoin(base, 'cuda/'))
    if unavailable:
        wait('!tabLab.gpu && Array.from(document.querySelectorAll("video")).some(v=>v.offsetWidth&&v.readyState>=1)', 10)
        assert val('async () => !(await navigator.gpu?.requestAdapter())')
        click('nvidia-smi')
        wait('tabLab.output.includes("WebGPU unavailable") && tabLab.output.includes("cudawg-smi")')
        val('() => { document.querySelector("#gpu-missing").scrollIntoView({block:"center"}); return true; }')
        print('Recorded fallback is visible and decoded without WebGPU', flush=True)
        screenshot('cuda-no-webgpu')
        return
    click('nvidia-smi')
    wait('tabLab.output.includes("cudawg-smi")')
    for button, expected in [('vecadd','errors=0 c[12345]=30862.5'),('matmul','errors=0 C[0]=-3.25'),('reduce','expected=300000 OK')]:
        val("""() => { window.commandDelay = null; document.addEventListener('click', () => {
          const start = performance.now(); const h = setInterval(() => {
            if(tabLab.output.includes("""+json.dumps(expected)+""")) { window.commandDelay=performance.now()-start; clearInterval(h); }
          }, 5);
        }, {once:true}); return true; }""")
        click(button)
        wait('window.commandDelay !== null', 30)
        delay = val('window.commandDelay')
        data = val('({bootMs:tabLab.bootMs,cpus:tabLab.cpus,memoryMiB:tabLab.memoryMiB})')
        mark_measured('cuda', dict(data, example=button, runMs=delay))
        print('CUDA ' + button + f' in {delay:.0f} ms: ' + expected, flush=True)
    # Record time on the page itself, starting on the trusted button click.
    val("""() => { window.frameDelay = null; document.addEventListener('click', () => {
       const start = performance.now(); const h = setInterval(() => {
          if (tabLab.output.includes('▀')) { window.frameDelay = performance.now()-start; clearInterval(h) }
       }, 10);
    }, {once:true}); return true; }""")
    click('tunnel')
    wait('window.frameDelay !== null', 10)
    delay = val('window.frameDelay')
    assert delay <= 10000, delay
    data = val('({bootMs:tabLab.bootMs,cpus:tabLab.cpus,memoryMiB:tabLab.memoryMiB})')
    mark_measured('cuda', dict(data, example='tunnel', runMs=delay))
    click('Ctrl+C')
    print(f'CUDA tunnel first U+2580 after {delay:.0f} ms', flush=True)
    wait('tabLab.output.includes("\\x1b[?25h")')
    screenshot('cuda')
    check_console()
    cli('goto', base)
    assert val('document.documentElement.scrollWidth <= innerWidth')
    screenshot('landing')


def latest_run():
    return val(r"""() => tabLab.output.split('$ cargo run --locked\r\n').pop().slice(-12000)""")


def save_fractal():
    # Decode the two colors of each U+2580 in the received terminal stream.
    # Returning one compact RGB frame per CLI read avoids truncating ANSI logs.
    count = val(r"""() => {
      const frames = [];
      const stream = tabLab.output.split('$ cargo run --locked\r\n').pop();
      const colors = /\x1b\[38;2;(\d+);(\d+);(\d+)m\x1b\[48;2;(\d+);(\d+);(\d+)m▀/g;
      for (const part of stream.split('\x1b[16A')) {
        const cells = Array.from(part.matchAll(colors)).slice(-44 * 16);
        if(cells.length !== 44 * 16) continue;
        const pixels = new Uint8Array(44 * 32 * 3);
        cells.forEach((cell, index) => {
          const x = index % 44, y = Math.floor(index / 44) * 2;
          for(let row=0; row < 2; row++) {
            pixels.set(cell.slice(1 + row * 3, 4 + row * 3).map(Number), ((y + row)*44 + x)*3);
          }
        });
        frames.push(btoa(String.fromCharCode(...pixels)));
      }
      window.__qaFractalFrames = frames;
      return frames.length;
    }""")
    frames = [base64.b64decode(val(f'window.__qaFractalFrames[{i}]')) for i in range(count)]
    if len(frames) < 2 or all(frame == frames[0] for frame in frames):
        raise ValueError('Need two distinct complete Rust/CUDA frames for the GIF')
    with tempfile.TemporaryDirectory() as path:
        for index, pixels in enumerate(frames):
            (Path(path) / f'{index:02d}.ppm').write_bytes(b'P6\n44 32\n255\n' + pixels)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '8',
                        '-i', str(Path(path) / '%02d.ppm'), '-filter_complex',
                        'scale=352:256:flags=neighbor,split[a][b];[a]palettegen[p];[b][p]paletteuse',
                        '-loop', '0', str(OUT / 'rust-cuda.gif')], check=True)

def mark_measured(mode, data):
    data['mode'] = mode
    MEASUREMENTS.append(data)
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / 'measurements.jsonl').open('a') as f:
        f.write(json.dumps(data, ensure_ascii=False) + '\n')


def action(label, timeout=900):
    before = val('Number(document.querySelector("#rust-stats").dataset.seq || 0)')
    click(label)
    wait(f'Number(document.querySelector("#rust-stats").dataset.seq)>{before} && ["ready","error"].includes(document.querySelector("#rust-stats").dataset.state)', timeout)
    data = val('({...document.querySelector("#rust-stats").dataset,bootMs: tabLab.bootMs})')
    assert data['state'] == 'ready', (data,val('tabLab.output.slice(-2000)'))
    return data


def rust(base, cpus, unavailable=False, subset=None):
    visit(urljoin(base, 'rust/') + '?cpus=' + str(cpus))
    boot_bytes = val('Number(document.querySelector("#rust-stats").dataset.imageBytes)')
    if unavailable:
        assert val('async () => !tabLab.gpu && !(await navigator.gpu?.requestAdapter())')
    examples = {'hello':'Squares: [1, 4, 9, 16, 25, 36]', 'json':'Basel', 'rayon':'500000500000', 'query':'Zürich'}
    if not unavailable:
        examples['fractal'] = '▀'
    if subset:
        examples = {key: examples[key] for key in subset}
    for example, expected in examples.items():
        cli('select', ref('combobox', 'Example'), example)
        for attempt in ['first','warm'] if not unavailable else ['first']:
            prior_bytes = val('Number(document.querySelector("#rust-stats").dataset.imageBytes)')
            data = action('Run')
            data.update(bootImageBytes=boot_bytes, actionImageBytes=int(data['imageBytes'])-prior_bytes)
            output = latest_run()
            assert expected in output, (example, output[-1200:])
            if example == 'query':
                assert re.search(r'Basel\s+26', output) and re.search(r'Zürich\s+44', output)
            if example == 'json':
                readings = [json.loads(line) for line in re.findall(r'\{[^{}\r\n]+\}', output) if '"fahrenheit":' in line]
                values = {r['station']: r['fahrenheit'] for r in readings}
                assert abs(values['Zürich'] - 60.8) < 0.001 and abs(values['Basel'] - 65.3) < 0.001, values
            data.update(example=example,attempt=attempt)
            mark_measured('no-webgpu' if unavailable else 'webgpu',data)
            print(json.dumps(data,ensure_ascii=False),flush=True)
        if example == 'fractal':
            screenshot('rust')
            save_fractal()
        elif example == 'hello' and unavailable:
            screenshot('rust-no-webgpu')
    if not unavailable and not subset:
        format_share()


def format_share():
    cli('select', ref('combobox','Example'), 'hello')
    edit = ref('textbox','Rust source code')
    cli('click', edit)
    cli('press','Meta+a')
    cli('type','fn main(){println!("format test");}')
    data = action('Format')
    actual = val('document.querySelector(".cm-content").innerText')
    assert 'fn main() {' in actual and '    println!' in actual, actual
    click('Share')
    wait('location.hash.length>3')
    url = val('location.href')
    cli('goto','about:blank')
    cli('goto',url)
    wait('document.querySelector(".cm-content")?.innerText.includes("format test")')
    assert val('document.querySelector(".cm-content").innerText') == actual
    print('Format changed source; shared link restored original formatted code.', flush=True)



def extra_tools(base, cpus):
    visit(urljoin(base,'rust/') + '?cpus=' + str(cpus))
    cli('click', ref('textbox', 'Terminal input'))
    # The release profile has a separate Cargo cache. Use the real hello example
    # in a std-only crate to verify the buttons without compiling unused crates.
    cli('type', """printf '[package]\\nname="toolcheck"\\nversion="0.1.0"\\nedition="2021"\\n' > /work/Cargo.toml && cd /work && cargo generate-lockfile --offline && echo TOOLS_READY""")
    cli('press', 'Enter')
    wait(r'/\r?\nTOOLS_READY\r?\n/.test(tabLab.output)')
    for label in ['Test','Clippy','Release']:
        data = action(label)
        if label == 'Test':
            assert val('tabLab.output.includes("1 passed")')
        if label == 'Release':
            assert val('tabLab.output.includes("Hello from Linux!")')
        mark_measured('std-only-toolcheck',data)
        print(f'{label} passed: {data["elapsedMs"]} ms',flush=True)


def probe(base, cpus):
    visit(urljoin(base,'rust/') + '?cpus=' + str(cpus))
    # A new crate with no third-party dependencies checks the actual executable
    # toolchain even in a diagnostic disk that is still warming its Cargo cache.
    area = ref('textbox','Terminal input')
    cli('click', area)
    command = """cd /tmp && cargo new --offline --vcs none probe && cd probe && cargo run --offline"""
    cli('type', command)
    cli('press','Enter')
    wait('tabLab.output.includes("Hello, world!") || tabLab.output.includes("error:")', 240)
    print(val('tabLab.output.slice(-1700)'), flush=True)
    assert val('tabLab.output.includes("Hello, world!")')
    format_share()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('suite',choices=['cuda','rust','cuda-fallback','rust-fallback','probe','tools'])
    parser.add_argument('--cpus',type=int,default=1)
    parser.add_argument('--examples',nargs='+')
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    try:
        fallback = args.suite.endswith('-fallback')
        config = json.loads((ROOT/'qa/chromium.json').read_text())
        config['outputDir'] = str(OUT / 'session')
        if fallback:
            config['browser']['launchOptions']['args'] = ['--enable-features=WebAssemblyJSPI', '--disable-gpu', '--disable-software-rasterizer', '--disable-features=WebGPUService']
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
            json.dump(config, f)
            f.flush()
            cli('open', 'about:blank', '--config='+f.name)
        if args.suite == 'probe':
            probe(args.url,args.cpus)
        elif args.suite == 'tools':
            extra_tools(args.url,args.cpus)
        elif args.suite.startswith('cuda'):
            cuda(args.url,fallback)
        else:
            rust(args.url,args.cpus,fallback,args.examples)
        check_console()
    finally:
        cli('close',ok=False)


if __name__ == '__main__':
    main()
