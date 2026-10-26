"""
merge_exports.py
Usage:
    python merge_exports.py --input ./exports --output ./master
Needs:
    pip install pandas openpyxl

run:
    pip install pandas openpyxl
    python merge_exports.py --input ./exports --output ./master

"""
import argparse, zipfile, io, shutil
from pathlib import Path
import pandas as pd

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input',  default='.', help='Folder containing qrlogger_*.zip files')
    ap.add_argument('--output', default='./master', help='Output folder')
    args = ap.parse_args()

    in_dir  = Path(args.input)
    out_dir = Path(args.output)
    img_dir = out_dir / 'images'
    out_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(parents=True, exist_ok=True)

    frames = []
    zips = sorted(in_dir.glob('*.zip'))
    if not zips:
        print('No .zip files found in', in_dir.resolve()); return

    for zp in zips:
        print('Processing', zp.name)
        with zipfile.ZipFile(zp) as z:
            # read log.xlsx
            try:
                with z.open('log.xlsx') as f:
                    df = pd.read_excel(io.BytesIO(f.read()))
                    df['source_zip'] = zp.name
                    frames.append(df)
            except KeyError:
                print('  (no log.xlsx inside, skipping metadata)')
            # extract images/*
            for name in z.namelist():
                if name.startswith('images/') and not name.endswith('/'):
                    target = img_dir / Path(name).name
                    if target.exists():
                        # avoid overwriting a different file with same name
                        stem, suf = target.stem, target.suffix
                        i = 2
                        while (img_dir / f'{stem}__dup{i}{suf}').exists(): i += 1
                        target = img_dir / f'{stem}__dup{i}{suf}'
                    with z.open(name) as src, open(target,'wb') as dst:
                        shutil.copyfileobj(src, dst)

    if not frames:
        print('No metadata merged.'); return

    master = pd.concat(frames, ignore_index=True)
    before = len(master)
    master = master.drop_duplicates(subset=['filename'], keep='first')
    print(f'Rows: {before} -> {len(master)} after dedup on filename')

    # Summary sheet
    summary = (master.groupby('qr', dropna=False)
                     .agg(photos=('filename','count'),
                          first_seen=('timestamp','min'),
                          last_seen=('timestamp','max'))
                     .reset_index()
                     .sort_values('photos', ascending=False))

    out_xlsx = out_dir / 'master_log.xlsx'
    with pd.ExcelWriter(out_xlsx, engine='openpyxl') as w:
        master.to_excel(w, sheet_name='All records', index=False)
        summary.to_excel(w, sheet_name='Summary by QR', index=False)

    print('Wrote', out_xlsx)
    print('Images copied to', img_dir)

if __name__ == '__main__':
    main()
