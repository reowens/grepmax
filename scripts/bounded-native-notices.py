"""Bundle notices from the locked, target-filtered Cargo dependency graph.

Cargo metadata is generated on the build runner without compiling anything.
Missing published license files use reviewed, immutable upstream supplements.
No network access or license inference occurs in this script.
"""
import json
from pathlib import Path
import sys


def notices(metadata_path, output):
    metadata = json.loads(Path(metadata_path).read_text())
    native = Path(__file__).resolve().parents[1] / 'lance-maintenance/native'
    supplements = native / 'license-supplements'
    sources = json.loads((supplements / 'sources.json').read_text())
    nodes = {node['id']: node for node in metadata['resolve']['nodes']}
    reached = set()
    pending = [metadata['resolve']['root']]
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        reached.add(name)
        pending.extend(dep['pkg'] for dep in nodes[name]['deps']
                       if any(kind['kind'] != 'dev' for kind in dep['dep_kinds']))
    sections = ['gmax bounded maintenance third-party notices\n'
                'Lance engine 12.0.0; exact locked build dependencies.\n'
                'Build-only dependencies may be included conservatively.\n']
    packages = sorted((pkg for pkg in metadata['packages']
                       if pkg['id'] in reached and pkg['source'] is not None),
                      key=lambda pkg: (pkg['name'], pkg['version']))
    for package in packages:
        name = package['name'] + '@' + package['version']
        root = Path(package['manifest_path']).parent
        files = sorted(file for file in root.rglob('*')
                       if file.is_file() and file.name.lower().startswith(
                           ('license', 'copying', 'notice', 'copyright')))
        explicit = package.get('license_file')
        if explicit:
            file = root / explicit
            if file not in files:
                files.append(file)
        sections.append('\n' + '=' * 72 + '\n' + name + '\n'
                        + 'Declared license: ' + str(package['license']) + '\n'
                        + 'Repository: ' + str(package['repository']) + '\n'
                        + 'Authors: ' + '; '.join(package['authors']) + '\n')
        # Several Lance workspace crates omit the workspace license file.
        # Always include their checked upstream supplement as well as headers.
        supplements_for_package = sources.get(name, [])
        if not files and not supplements_for_package:
            raise ValueError('Missing license text: ' + name)
        for file in files:
            if file.is_symlink() or file.stat().st_size > 1024**2:
                raise ValueError('Unsafe license file: ' + str(file))
            sections.append('\n--- ' + str(file.relative_to(root)) + ' ---\n'
                            + file.read_text(encoding='utf8'))
        for supplement in supplements_for_package:
            file = supplements / supplement['file']
            if file.parent != supplements or file.is_symlink():
                raise ValueError('Unsafe license supplement')
            sections.append('\n--- ' + supplement['source'] + ' ---\n'
                            + supplement.get('attribution', '') + '\n'
                            + file.read_text(encoding='utf8'))
        if package['license'] == 'MPL-2.0':
            sections.append('\nUnmodified source for this covered dependency: '
                            + 'https://crates.io/api/v1/crates/' + package['name']
                            + '/' + package['version'] + '/download\n')
    text = '\n'.join(sections)
    if len(text.encode()) > 8 * 1024**2:
        raise ValueError('Notices exceed packaging limit')
    Path(output).write_text(text, encoding='utf8')
    print('Bundled notices for', len(packages), 'locked dependency packages')


if __name__ == '__main__':
    notices(*sys.argv[1:])
