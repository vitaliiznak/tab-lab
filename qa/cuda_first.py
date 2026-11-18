"""Browser checks for the CUDA landing page and its editable Rust project."""
import json
import subprocess
from urllib.parse import urljoin, urlsplit, urlunsplit

import browser as qa


def control(selector):
    return qa.val(f'(() => {{ const e=document.querySelector({json.dumps(selector)}); return e.getAttribute("aria-label") || e.innerText.trim(); }})()')


def terminal(cmd, result):
    qa.cli('click', qa.ref('textbox', 'Terminal input'))
    qa.cli('type', cmd)
    qa.cli('press', 'Enter')
    qa.wait(f'tabLab.output.includes({json.dumps(result)})', 30)


def frame_pixels(selector, name):
    filename = qa.OUT / (name + '.png')
    qa.cli('screenshot', selector, '--filename=' + str(filename))
    return subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(filename), '-vf', 'scale=80:45',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ])


def rust(base, via_link=True):
    if via_link:
        link = qa.val('document.querySelector("#rust-feature-link").href')
        assert 'example=fractal' in link and '/rust/' in link, link
        qa.cli('click', '#rust-feature-link')
        qa.wait('window.tabLab?.ready && document.querySelector("#rust-example")?.value === "fractal"', 180)
    else:
        qa.visit(urljoin(base, 'rust/?example=fractal'))
    assert qa.val('document.querySelector(".cm-content").innerText.includes("fn render(")')
    qa.click(control('[data-rust-file="build.rs"]'))
    assert 'cudawgc.py' in qa.val('document.querySelector(".cm-content").innerText')
    qa.click(control('[data-rust-file="kernels.cu"]'))
    assert '__global__ void mandelbrot' in qa.val('document.querySelector(".cm-content").innerText')
    built = qa.action('Run', 600)
    assert built['exitCode'] == '0', built
    frames = qa.val(r"""() => {
      const frames = tabLab.output.split('\x1b[16A').map(part =>
        Array.from(part.matchAll(/\x1b\[38;2;\d+;\d+;\d+m\x1b\[48;2;\d+;\d+;\d+m▀/g), match => match[0]).slice(-704)
      ).filter(frame => frame.length === 704).map(frame => frame.join(''));
      return {complete:frames.length, distinct:new Set(frames).size};
    }""")
    assert frames['distinct'] >= 2, frames
    print(f'Rust/CUDA built in {built["elapsedMs"]} ms and drew {frames}.', flush=True)

    # A private browser edit should re-open with the CUDA file selected, even
    # if the query string identifies a different stock example.
    original = (qa.ROOT / 'src/rust/examples/kernels.cu').read_text()
    note = '// QA shared CUDA source'
    edit = qa.ref('textbox', 'CUDA kernel source code')
    qa.cli('fill', edit, note + '\n' + original)
    qa.click('Share')
    qa.wait('location.hash.startsWith("#code=")')
    link = urlsplit(qa.val('location.href'))
    qa.cli('goto', 'about:blank')
    qa.cli('goto', urlunsplit(link._replace(query='example=hello')))
    qa.wait(f'document.querySelector(".cm-content")?.innerText.includes({json.dumps(note)})')
    assert qa.val('document.querySelector("#rust-example").value') == 'fractal'
    assert qa.val('document.querySelector("[data-rust-file][aria-pressed=true]").dataset.rustFile') == 'kernels.cu'
    qa.check_console()

    qa.visit(urljoin(base, 'rust/'))
    assert qa.val('document.querySelector("#rust-example").value') == 'hello'
    result = qa.action('Run', 600)
    assert result['exitCode'] == '0' and 'Squares: [1, 4, 9, 16, 25, 36]' in qa.latest_run()
    qa.format_share()
    qa.check_console()
    print('Plain Rust CPU hello and both project share formats passed.', flush=True)


def fallback(base):
    # Mask the WebGPU API only on this tab, preserving the real GPU session.
    qa.cli('tab-new', 'about:blank')
    try:
        qa.cli('run-code', """async page => {
          await page.addInitScript(() =>
            Object.defineProperty(Navigator.prototype, 'gpu', {get:()=>undefined, configurable:true}));
        }""")
        qa.visit(base)
        qa.wait('!tabLab.gpu && document.querySelector("#gpu-missing video")?.offsetWidth > 0', 30)
        assert not qa.val('Boolean(navigator.gpu)')
        qa.val('async () => {const video=document.querySelector("#gpu-missing video"); video.muted=true; await video.play(); return true;}')
        qa.wait('document.querySelector("#gpu-missing video").currentTime>0 && document.querySelector("#gpu-missing video").videoWidth>0')
        qa.val('() => {document.querySelector("#gpu-missing video").pause(); return true;}')
        terminal("echo QA_''CPU_SHELL", 'QA_CPU_SHELL')
        qa.check_console()
        qa.visit(urljoin(base, 'rust/?example=fractal'))
        assert qa.val('document.querySelector("[data-rust-action=run]").disabled')
        qa.click(control('#rust-cpu-choice'))
        qa.wait('document.querySelector("#rust-example").value==="hello" && !document.querySelector("[data-rust-action=run]").disabled')
        qa.check_console()
        print('No-WebGPU browser API fallback: recording, live shell, and CPU Rust alternative passed.', flush=True)
    finally:
        qa.cli('tab-close', '1')
        qa.cli('tab-select', '0')


def terminal_cuda(base):
    qa.visit(urljoin(base, 'cuda/'))
    qa.wait('document.body.dataset.tunnelState === "running" && tabLab.output.includes("▀")', 20)
    # Capture the state at the actual button click to cover interruption.
    qa.val("""() => {
        document.querySelector('[data-cmd=vecadd]').addEventListener('click',
            () => { window.qaTunnelAtClick = document.body.dataset.tunnelState; },
            {once:true, capture:true});
        return true;
    }""")
    qa.cli('click', '[data-cmd=vecadd]')
    qa.wait('tabLab.output.includes("errors=0 c[12345]=30862.5")', 30)
    assert qa.val('window.qaTunnelAtClick') == 'running'
    qa.check_console()
    qa.visit(urljoin(base, 'cuda/?inspect=1'))
    qa.wait('document.querySelector("#guest-proof")?.textContent.includes("aarch64")', 30)
    assert qa.val('document.body.dataset.tunnelState === "idle" && !tabLab.output.includes("▀")')
    assert 'unreachable' in qa.val('document.querySelector("#guest-proof").textContent').lower()
    print('CUDA command interrupted the active default tunnel; isolated inspector opened quietly.', flush=True)
    qa.check_console()


def mobile_data(base):
    qa.cli('resize', '390', '844')
    try:
        qa.visit(base)
        qa.wait('Number(document.querySelector("#flight-canvas")?.dataset.frame) > 0', 45)
        assert qa.val('document.documentElement.scrollWidth <= innerWidth')
        assert qa.val('document.querySelector("#flight-canvas").getBoundingClientRect().width <= innerWidth')
        qa.screenshot('cuda-mobile')
        qa.cli('click', qa.ref('link', 'DuckDB'))
        qa.wait('window.tabLab?.ready && document.querySelector("#day-passages")?.textContent.trim()==="568"', 150)
        assert qa.val('document.documentElement.scrollWidth <= innerWidth')
    finally:
        qa.cli('resize', '1280', '800')
    print('Mobile GPU display fits 390px; DuckDB navigation booted its live data.', flush=True)


def flight(base):
    qa.visit(base)
    qa.wait('document.querySelector("#flight")?.dataset.state==="complete" || document.querySelector("#flight")?.dataset.state==="error"', 75)
    assert qa.val('document.querySelector("#flight-canvas").dataset.frame') == '120', qa.val('document.querySelector("#flight-status").textContent')
    assert qa.val('crossOriginIsolated && tabLab.gpu && document.querySelector("#flight-poster").hidden')
    terminal("uname -m | sed 's/^/CPU_/'", 'CPU_aarch64')
    qa.cli('click', '#flight-camera')
    qa.wait('document.querySelector("#flight").dataset.state==="paused" && Math.abs(Number(document.querySelector("#flight-canvas").dataset.frame)-60)<=1')
    qa.val('() => {window.scrollTo(0,0); return true;}')
    qa.screenshot('flight')
    mid = frame_pixels('#flight-canvas', 'flight-mid')
    qa.cli('press', 'Home')
    qa.wait('document.querySelector("#flight-canvas").dataset.frame==="0" && document.querySelector("#flight").dataset.state==="paused"')
    start = frame_pixels('#flight-canvas', 'flight-start')
    qa.cli('select', qa.ref('combobox', 'Kernel view'), '1')
    qa.wait('document.querySelector("#flight-canvas").dataset.view==="1" && document.querySelector("#flight").dataset.state==="paused"')
    work = frame_pixels('#flight-canvas', 'flight-steps')
    assert qa.val('!document.querySelector("#work-legend").hidden')
    for label, left, right in [('camera 60 vs 0', mid, start), ('lit vs ray steps', start, work)]:
        # Compare actual composited screenshot pixels after downsampling. Ignore
        # tiny variations due to subpixel placement and compression.
        changed = sum(max(abs(a-b) for a,b in zip(left[i:i+3], right[i:i+3])) > 16
                      for i in range(0, len(left), 3)) / (len(left) / 3)
        assert changed > .1, (label, changed)
        print(f'{label}: {changed:.1%} of sampled canvas pixels changed.', flush=True)
    qa.cli('click', '#flight-expand')
    qa.wait('document.fullscreenElement?.id === "flight"')
    qa.cli('click', '#flight-expand')
    qa.wait('!document.fullscreenElement')
    qa.cli('click', '#flight-play')
    qa.wait('document.querySelector("#flight").dataset.state==="playing"')
    # Desktop headless Chrome reports both tabs as visible. Drive its documented
    # visibility event, then count presentations from the bridge after abort.
    paused = qa.val(r"""async () => {
        const canvas = document.querySelector('#flight-canvas');
        let presents = 0;
        const present = () => presents++;
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        canvas.addEventListener('cudawgframe', present);
        try {
            Object.defineProperty(document, 'hidden', {value:true, configurable:true});
            document.dispatchEvent(new Event('visibilitychange'));
            await wait(300);
            const before = presents;
            await wait(600);
            return document.querySelector('#flight').dataset.state==='paused' && presents===before;
        } finally {
            delete document.hidden;
            document.dispatchEvent(new Event('visibilitychange'));
            canvas.removeEventListener('cudawgframe', present);
        }
    }""")
    assert paused, 'Guest continued to present frames after visibility was set to hidden.'
    qa.check_console()


def reduced_motion(base):
    qa.cli('set-reduced-motion', 'reduce')
    try:
        qa.visit(base)
        qa.wait('document.querySelector("#flight").dataset.state==="paused" && document.querySelector("#flight-canvas").dataset.frame==="0"')
    finally:
        qa.cli('clear-reduced-motion')


def run(base):
    base = base.rstrip('/') + '/'
    flight(base)
    rust(base)
    terminal_cuda(base)
    mobile_data(base)
    fallback(base)
    reduced_motion(base)
