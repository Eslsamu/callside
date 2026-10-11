from pathlib import Path
import hashlib,json,subprocess,zipfile,shutil,sys

root=Path('.local/package-inspection').resolve()
root.mkdir(parents=True,exist_ok=True)
commit='45588b567c961c1c53281444b7bb1def12524219'
artifacts=root/'artifacts'
installer_root=artifacts/('Callside-Windows-Test-x64-Installer-'+commit)
portable_root=artifacts/('Callside-Windows-Test-x64-Portable-'+commit)
installer=installer_root/'Callside-Windows-Test-x64.exe'
portable=portable_root/'Callside-Windows-Test-x64.zip'
seven=shutil.which('7z') or shutil.which('7zz')
assert seven,'7-Zip is required for static archive inspection'

def sha_file(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()

def seven_run(*args):
    return subprocess.run([seven,*map(str,args)],check=True,capture_output=True,text=True).stdout

build=json.loads((installer_root/'BUILD.json').read_text(encoding='utf-8-sig'))
assert build['commit']==commit,build
assert (installer_root/'BUILD.json').read_bytes()==(portable_root/'BUILD.json').read_bytes()
assert (installer_root/'SHA256SUMS.txt').read_bytes()==(portable_root/'SHA256SUMS.txt').read_bytes()
sums=dict(line.strip().split('  ',1)[::-1] for line in (installer_root/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines() if line.strip())
files=[]
for p in (installer,portable):
    digest=sha_file(p)
    assert sums[p.name]==digest,(p.name,'checksum mismatch')
    files.append({'name':p.name,'bytes':p.stat().st_size,'sha256':digest})
listing=seven_run('l','-slt',installer)
(root/'installer-list.txt').write_text(listing)
assert 'spiderbanner.dll' not in listing.lower(),'One-click banner is still bundled'
extracted=root/'extracted'
seven_run('x',installer,'-o'+str(extracted),'-y')
payload=extracted/'payload'
archives=list(extracted.rglob('app-64.7z'))
assert len(archives)==1,archives
seven_run('x',archives[0],'-o'+str(payload),'-y')
installed={str(p.relative_to(payload)):sha_file(p) for p in payload.rglob('*') if p.is_file()}
assert not any(p.lower().endswith('/elevate.exe') for p in installed),'Unused elevation helper is still bundled'
with zipfile.ZipFile(portable) as z:
    portable_files={}
    for i in z.infolist():
        if not i.is_dir():
            with z.open(i) as f:
                portable_files[i.filename]=hashlib.file_digest(f,'sha256').hexdigest()
assert installed==portable_files,'Installer app payload and portable app differ'
plugins=[{'name':p.name,'bytes':p.stat().st_size,'sha256':sha_file(p)} for p in (extracted/'$PLUGINSDIR').glob('*.dll')]
report={'build':build,'packages':files,'installer_plugins':plugins,'payload_files':len(installed),'portable_payload_identical':True,'spider_banner_absent':True,'elevation_helper_absent':True,'browser_verdict':'Not yet tested','scope':'Static package inspection only; no installer or app execution.'}
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
