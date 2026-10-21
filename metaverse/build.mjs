import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const r = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2020'],
  legalComments: 'none',
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/style.css', 'utf8');
// 고려대학교 엠블럼(배경 제거·잡음 정리) · 탭 아이콘용 작은 엠블럼 · 고려대학교 차세대통신학과 가로형
const emblem = readFileSync('assets/ku_emblem.datauri.txt', 'utf8').trim();
const favicon = readFileSync('assets/ku_emblem_fav.datauri.txt', 'utf8').trim();
const dept = readFileSync('assets/ku_dept.datauri.txt', 'utf8').trim();
const body = readFileSync('src/body.html', 'utf8').replaceAll('__EMBLEM__', emblem).replaceAll('__DEPT__', dept);

const TITLE = 'Right Guard 메타버스';
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Noto+Sans+KR:wght@400;500;700&display=swap">';

const full = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE}</title>
<link rel="icon" href="${favicon}">
${fonts}
<style>${css}</style>
</head>
<body>
${body}
<script>${js}</script>
</body>
</html>
`;
const artifact = `<title>${TITLE}</title>
${fonts}
<style>${css}</style>
${body}
<script>${js}</script>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/RightGuard_Metaverse.html', full);
writeFileSync('dist/artifact.html', artifact);
// npm run build:site → 사이트에 바로 반영 (저장소 맨 위의 RightGuard_Metaverse.html 을 덮어씀)
if (process.argv.includes('--site')) {
  writeFileSync('../RightGuard_Metaverse.html', full);
  console.log('updated ../RightGuard_Metaverse.html');
}
console.log('js', (js.length / 1024).toFixed(0) + 'KB', 'full', (full.length / 1024).toFixed(0) + 'KB');
