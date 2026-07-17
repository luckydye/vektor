#!/usr/bin/env python3

import re
from pathlib import Path

# Read the icons.svg file
input_file = Path(__file__).parent.parent / 'icons.svg'
output_dir = Path(__file__).parent

with open(input_file, 'r', encoding='utf-8') as f:
    content = f.read()


def write_icon(filename: str, svg_content: str) -> None:
    output_path = output_dir / filename
    normalized_svg = re.sub(r'\bblack\b', 'currentColor', svg_content, flags=re.IGNORECASE)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(normalized_svg)
    print(f'Created: {filename}')


# Split by lines
lines = content.split('\n')

current_filename = None
current_svg = []
in_svg = False

for line in lines:
    # Check for filename comment (e.g., <!-- 24x24-plus.svg -->)
    filename_match = re.search(r'<!--\s*(.+\.svg)\s*-->', line)
    if filename_match:
        current_filename = filename_match.group(1)
        # Check if SVG starts on the same line
        if '<svg' in line:
            in_svg = True
            # Extract just the SVG part
            svg_start = line.index('<svg')
            current_svg = [line[svg_start:]]
            if '</svg>' in line:
                # Entire SVG is on one line
                in_svg = False
                svg_content = current_svg[0]
                write_icon(current_filename, svg_content)
                current_filename = None
                current_svg = []
        continue

    # Check for start of SVG (if not already started on comment line)
    if '<svg' in line and current_filename and not in_svg:
        in_svg = True
        current_svg = [line]
        # Check if it ends on the same line
        if '</svg>' in line:
            in_svg = False
            svg_content = '\n'.join(current_svg)
            write_icon(current_filename, svg_content)
            current_filename = None
            current_svg = []
        continue

    # Collect SVG content
    if in_svg:
        current_svg.append(line)

        # Check for end of SVG
        if '</svg>' in line:
            in_svg = False

            svg_content = '\n'.join(current_svg)
            write_icon(current_filename, svg_content)

            # Reset
            current_filename = None
            current_svg = []

print('\nAll icons extracted successfully!')
