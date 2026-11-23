"""Native packaged-app caret regression. See README.md before using the screen.

Uses real demo data, native input and window pixels. A focused, empty editor must
paint at least one caret-on frame in 2–3 seconds; normal blink-off frames are valid.
No DOM-only assertion substitutes for that check. Output stays outside the project.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from contextlib import suppress

from PIL import Image, ImageChops


def vertical_run(image, reference):
    difference = ImageChops.difference(image, reference)
    red, green, blue = difference.split()
    mask = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    box, longest = mask.getbbox(), 0
    if box:
        for x in range(box[0], box[2]):
            run = 0
            for y in range(box[1], box[3]):
                run = run + 1 if mask.getpixel((x, y)) >= 16 else 0
                longest = max(longest, run)
    return longest


class Lab:
    def __init__(self, build, output):
        self.build, self.output = build.resolve(), output.resolve()
        self.app = self.build / 'Fluux Startup Lab.app'
        self.binary = self.app / 'Contents/MacOS/fluux'
        self.home = self.build / 'runtime-home'
        self.probe = self.home / 'Library/Application Support/net.processone.fluux.startup-lab/caret-probe'
        self.pid, self.sequence = None, 0
        self.results = []
        self.owned = False

    def pids(self):
        processes = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
        return [int(parts[0]) for line in processes.splitlines()
                if len(parts := line.split(maxsplit=1)) == 2
                and parts[1].startswith(str(self.binary) + ' ')]

    def call(self, op):
        self.sequence += 1
        temporary = self.probe / 'command.tmp'
        temporary.write_text(json.dumps(dict(id=self.sequence, op=op)))
        temporary.replace(self.probe / 'command.json')
        path = self.probe / f'result-{self.sequence}.json'
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                response = json.loads(path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(.035)
                continue
            (self.output / 'last-observer-response.json').write_text(json.dumps(response, indent=2))
            if 'error' in response:
                raise RuntimeError(response['error'])
            return response
        raise TimeoutError(f'Observer did not answer {op}')

    def until(self, predicate, op='state', seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            response = self.call(op)
            if predicate(response):
                return response
        raise TimeoutError(f'Observed state did not settle: {op}')

    def native(self, x=0, y=0, operation=None):
        arguments = [str(self.build / 'native-click'), str(self.pid), str(self.app), str(x), str(y)]
        if operation:
            arguments.append(operation)
        return subprocess.check_output(arguments, text=True).strip()

    def bounds(self):
        return list(map(float, self.native(operation='bounds').split()))

    def click(self, x, y, state):
        window, wx, wy, width, height = self.bounds()
        assert abs(width - state['view'][4]) < 3 and abs(height - state['view'][5]) < 3, 'Unexpected viewport offset'
        assert 0 <= x < width and 0 <= y < height, 'Click outside viewport'
        self.native(wx + x, wy + y)
        return window

    def screenshot(self, window, path):
        subprocess.run(['/usr/sbin/screencapture', '-x', '-o', '-l', str(int(window)), str(path)], check=True, timeout=4)
        with Image.open(path) as image:
            return image.convert('RGB')

    def start(self):
        assert self.binary.is_file() and (self.build / 'native-click').is_file()
        assert not self.home.exists() and not self.pids(), 'Use a fresh, stopped lab'
        self.owned = True
        self.probe.mkdir(parents=True)
        subprocess.run(['open', '-n', '--stdout', str(self.output / 'stdout.log'),
                        '--stderr', str(self.output / 'stderr.log'), str(self.app), '--args',
                        f'--lab-home={self.home}', f'--log-file={self.output}/app.log'], check=True)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if candidates := self.pids():
                self.pid = candidates[0]
                (self.output / 'app.pid').write_text(str(self.pid))
            log = (self.output / 'stderr.log').read_text(errors='replace') if (self.output / 'stderr.log').exists() else ''
            if 'ShowControls(' in log:
                raise RuntimeError('Native startup recovery covered the demo')
            if self.pid and any(line.rstrip().endswith(' Open') and 'startup recovery:' in line for line in log.splitlines()):
                break
            time.sleep(.08)
        else:
            raise TimeoutError('Native startup did not reach Open')
        ready = self.call('state')
        assert ready['readiness']['localOrigin'] == 'tauri://localhost', 'Not the packaged demo'
        self.native(operation='activate')
        self.until(lambda response: response['state']['focused'] and response['state']['rect'])

    def navigate(self, kind, identifier, label):
        response = self.call('state')
        box = response['nav'][kind]
        self.click(box['x'] + box['w'] / 2, box['y'] + box['h'] / 2, response['state'])
        response = self.until(lambda response: response['state']['hash'].startswith('#/' + kind))
        box = next(row['box'] for row in response['rows'] if row['id'] == identifier)
        self.click(box['x'] + box['w'] / 2, box['y'] + box['h'] / 2, response['state'])
        return self.until(lambda response: label in (response['state'].get('label') or ''))

    def capture(self, name, type_clear=False):
        armed = self.call('arm')
        before = armed['state']
        assert before['value'] == '', f'{name}: fixture is not empty'
        box = before['rect']
        x, y = box['x'] + before['pad'] + 22, box['y'] + box['h'] / 2
        native_before = self.native(operation='key')
        window = self.click(x, y, before)
        inputs = []
        if type_clear:
            self.until(lambda response: response['state']['editorFocus'])
            self.native(operation='x')
            inputs.append(self.until(lambda response: response['state']['value'] == 'x')['state'])
            self.native(operation='backspace')
            inputs.append(self.until(lambda response: response['state']['value'] == '')['state'])
        # Sample the actual focus owner beside every window capture, including
        # after clearing without another click or programmatic selection change.
        started, frames, dom_frames = time.monotonic(), [], []
        while time.monotonic() - started < 2.5:
            dom_frames.append(self.call('state')['state'])
            path = self.output / f'{name}-{len(frames)}.png'
            self.screenshot(window, path)
            frames.append(dict(ms=round((time.monotonic() - started) * 1000), path=path.name))
            remaining = started + len(frames) * .12 - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
        response = self.call('state')
        dom_frames.append(response['state'])
        observed = dict(before=before, frames=dom_frames, events=response['events'])
        native_after = self.native(operation='key')
        assert frames[-1]['ms'] - frames[0]['ms'] >= 1900 and frames[-1]['ms'] <= 3000, 'Capture interval incomplete'
        assert all(sample['focused'] and sample['editorFocus'] and sample['ring'] and sample['value'] == ''
                   for sample in observed['frames']), 'Editor lost focus, ring or empty state'
        assert observed['frames'][-1]['at'] - observed['frames'][0]['at'] >= 1900, 'DOM interval incomplete'
        clicks = [event for event in observed['events'] if event['type'] == 'click' and event['trusted']]
        assert len(clicks) == 1 and abs(clicks[0]['clientX'] - x) < 4 and abs(clicks[0]['clientY'] - y) < 4, 'Not one native composer click'
        if type_clear:
            keys = [event.get('key') for event in observed['events'] if event['type'] == 'keydown' and event['trusted']]
            assert keys == ['x', 'Backspace'], f'Unexpected native typing sequence: {keys}'
        assert native_before == native_after == f'focused {int(window)}', 'Native window lost focus'
        self.call('hide-reference')
        reference = self.screenshot(window, self.output / f'{name}-reference.png')
        self.call('show-reference')
        _, _, _, width, height = self.bounds()
        sx, sy = reference.width / width, reference.height / height
        crop = (round(box['x'] * sx), round(box['y'] * sy),
                round((box['x'] + box['w']) * sx), round((box['y'] + box['h']) * sy))
        reference = reference.crop(crop)
        # Eight CSS pixels is shorter than the real 16px glyph's insertion point,
        # but longer than antialiasing noise. The whole input crop is compared.
        for frame in frames:
            with Image.open(self.output / frame['path']) as image:
                frame['verticalPixels'] = vertical_run(image.convert('RGB').crop(crop), reference)
        painted = sum(frame['verticalPixels'] >= math.ceil(8 * sy) for frame in frames)
        result = dict(name=name, paintedFrames=painted, frames=frames, crop=crop, window=window,
                      nativeBefore=native_before, nativeAfter=native_after, observation=observed, inputStates=inputs)
        self.results.append(result)
        (self.output / 'samples.json').write_text(json.dumps(self.results, indent=2))
        print(f'{name}: caret painted in {painted}/{len(frames)} frames', flush=True)

    def stop(self):
        if not self.owned:
            return
        for pid in self.pids():
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while self.pids() and time.monotonic() < deadline:
            time.sleep(.05)
        for pid in self.pids():
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)
        shutil.rmtree(self.home, ignore_errors=True)
        (self.output / 'app.pid').unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('build', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--type-clear', action='store_true', help='Also type one unsent x, erase it and measure without refocusing')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    for path in (args.build, args.output):
        assert path.is_absolute() and not path.resolve().is_relative_to(root), 'Use absolute directories outside the project'
    source = (args.build / 'source.txt').read_text().strip()
    assert len(source) == 40 and all(char in '0123456789abcdef' for char in source), 'Missing source commit'
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'source.txt').write_text(source + '\n')
    lab = Lab(args.build, args.output)
    def interrupted(signum, frame):
        raise TimeoutError('Native lab interrupted or its 90-second bound expired')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(90)
    try:
        lab.start()
        lab.navigate('rooms', 'design@conference.fluux.chat', 'Design Review')
        lab.capture('room-empty')
        if args.type_clear:
            lab.capture('room-cleared', type_clear=True)
        lab.navigate('messages', 'emma@fluux.chat', 'Emma Wilson')
        lab.capture('direct-empty')
        assert all(result['paintedFrames'] > 0 for result in lab.results), 'Focused empty composer never painted its caret'
    finally:
        lab.stop()
        signal.alarm(0)


if __name__ == '__main__':
    main()
