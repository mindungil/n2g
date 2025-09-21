// scripts/notion-sync.mjs
// 요구사항 반영:
// 1) 파일명은 "제목(페이지명)" 기반 slug로 생성 (Slug 필드 미사용)
// 2) 노션 '배포' 체크박스가 켜진 항목만 처리, 성공 시 자동 해제(false)
// 3) _posts 내 "같은 제목(slug)" 파일이 이미 있으면 그 파일을 덮어써서 수정
//    - 우선 notion_id로 기존 파일을 찾고(제목 변경에도 안전), 없으면 slug-기반으로 찾기
// 4) 이미지 로컬 저장 및 링크 치환, cover → front matter image.path

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import slugify from "slugify";
import dayjs from "dayjs";
import yaml from "js-yaml";

// ──────────────────────────────────────────────────────────────
// 환경 변수
// ──────────────────────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;
const TZ = process.env.TIMEZONE || "Asia/Seoul";
const POSTS_DIR = process.env.POSTS_DIR || "_posts";
const ASSET_DIR = process.env.ASSET_DIR || "assets/img/for_post"; // repo 상대경로
const DOWNLOAD_COVER =
  (process.env.DOWNLOAD_COVER || "true").toLowerCase() === "true";

// 한글 워크스페이스 대응(노션 필드명)
const TITLE_KEYS = (process.env.TITLE_KEYS || "제목,Title,Name")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DATE_PROP = process.env.DATE_PROP || "생성일";
const DEPLOY_PROP = process.env.DEPLOY_PROP || "배포"; // 체크박스 이름
const TAG_PROP = process.env.TAG_PROP || "태그"; // 선택
const CATEGORY_PRIMARY_PROP = process.env.CATEGORY_PRIMARY_PROP || "카테고리";
const CATEGORY_SECONDARY_PROP = process.env.CATEGORY_SECONDARY_PROP || "분류";

process.env.TZ = TZ;

// ──────────────────────────────────────────────────────────────
// Notion / Markdown helpers
// ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const plain = (richArr = []) =>
  richArr
    .map((t) => t.plain_text)
    .join("")
    .trim();

function getTitle(props) {
  for (const k of TITLE_KEYS) {
    if (props[k]?.title?.length) return plain(props[k].title);
  }
  // 안전 fallback
  if (props.Name?.title?.length) return plain(props.Name.title);
  if (props.Title?.title?.length) return plain(props.Title.title);
  return "Untitled";
}

// 제목 기반 slug (Slug 필드 미사용)
function toSlugFromTitle(title) {
  return slugify(title || "post", { lower: true, strict: true, trim: true });
}

function ymd(dateStr) {
  return dayjs(dateStr).format("YYYY-MM-DD");
}
function y(dateStr) {
  return dayjs(dateStr).format("YYYY");
}
function toJekyllDateTime(dateStr) {
  return dayjs(dateStr).format("YYYY-MM-DD HH:mm:ss ZZ"); // e.g. +0900
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function sanitizeFileName(name) {
  return name.replace(/[^\w.\-]+/g, "_");
}

function extFromContentType(ct) {
  if (!ct) return null;
  const mime = ct.split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) return null;
  let ext = mime.split("/")[1];
  if (ext === "jpeg") ext = "jpg";
  return ext;
}
function extFromUrl(u) {
  try {
    const pathname = new URL(u).pathname;
    const base = pathname.split("/").pop() || "";
    const dot = base.lastIndexOf(".");
    if (dot > -1 && dot < base.length - 1) {
      const ext = base.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    }
  } catch {}
  return null;
}
async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 NotionSync" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  const ct = res.headers.get("content-type") || "";
  return { buf: Buffer.from(ab), contentType: ct };
}
async function saveImageFromUrl(url, destDir, baseNameHint) {
  ensureDir(destDir);
  let ext = extFromUrl(url);
  let buf, ct;
  try {
    const r = await fetchBuffer(encodeURI(url));
    buf = r.buf;
    ct = r.contentType;
  } catch (e) {
    console.warn(`⚠️  Image download failed: ${url} (${e.message})`);
    return null;
  }
  if (!ext) ext = extFromContentType(ct) || "png";
  const base = sanitizeFileName(baseNameHint || "img");
  let name = `${base}.${ext}`,
    i = 1;
  while (fs.existsSync(path.join(destDir, name))) {
    name = `${base}-${String(i++).padStart(2, "0")}.${ext}`;
  }
  fs.writeFileSync(path.join(destDir, name), buf);
  return name;
}
function replaceMarkdownImageUrls(md, replacer) {
  // ![alt](url "title") 단순 패턴
  return md.replace(
    /!\[([^\]]*)\]\((\s*<?([^)\s]+)>?)(?:\s+"[^"]*")?\)/g,
    (m, alt, _u1, url) => `![${alt}](${replacer(url, alt) || url})`
  );
}

// Front Matter 파서 (기존 파일 확인용)
function readFrontMatter(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm = yaml.load(m[1] || "") || {};
  const body = m[2] || "";
  return { fm, body };
}

// notion_id 매칭 우선(제목 변경에도 안전), 없으면 slug로 파일 찾기
function findExistingPostFileByNotionIdOrSlug(pageId, slug) {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".md"));

  // 1) notion_id 매칭
  for (const f of files) {
    const full = path.join(POSTS_DIR, f);
    try {
      const { fm } = readFrontMatter(full);
      if (fm?.notion_id === pageId) return full;
    } catch {}
  }

  // 2) 파일명의 "-slug.md" 매칭(날짜 무시)
  const suffix = `-${slug}.md`;
  const hit = files.find((f) => f.endsWith(suffix));
  return hit ? path.join(POSTS_DIR, hit) : null;
}

async function pageToMarkdown(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const md = n2m.toMarkdownString(mdBlocks);
  return typeof md === "string" ? md : md.parent;
}

function getSelectOrMultiNames(props, propName) {
  const p = props?.[propName];
  if (!p) return [];
  if (p.multi_select?.length) return p.multi_select.map((t) => t.name);
  const s = p.select?.name;
  return s ? [s] : [];
}
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// 배포 대상(배포 체크 true)만 조회
async function queryDeployQueue() {
  const pages = [];
  let cursor = undefined;
  while (true) {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 50,
      filter: { property: DEPLOY_PROP, checkbox: { equals: true } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    pages.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return pages;
}

async function run() {
  if (!NOTION_TOKEN || !DB_ID) {
    console.error("❌ NOTION_TOKEN or NOTION_DATABASE_ID is missing.");
    process.exit(1);
  }
  ensureDir(POSTS_DIR);

  const deployPages = await queryDeployQueue();
  let changed = 0;

  for (const p of deployPages) {
    const pageId = p.id;
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = page.properties || {};

    // ── 제목/날짜
    const title = getTitle(props);
    const slug = toSlugFromTitle(title); // 요구사항 1
    const dateRaw = props[DATE_PROP]?.date?.start || p.created_time;
    const dateForFrontMatter = toJekyllDateTime(dateRaw);
    const dateForFile = ymd(dateRaw);
    const year = y(dateRaw);

    // ── 카테고리/태그 (카테고리=대분류, 분류=소분류)
    const catsPrimary = getSelectOrMultiNames(props, CATEGORY_PRIMARY_PROP); // 예: ["일상"]
    const catsSecondary = getSelectOrMultiNames(props, CATEGORY_SECONDARY_PROP); // 예: ["블로그"]
    // Chirpy 권장 구조: [대분류, 소분류] 최대 2개
    const categoriesArr = uniq([catsPrimary[0], catsSecondary[0]]).slice(0, 2);

    // 태그: 멀티셀렉트 기준 (보조로 "Tags"/"Tag"도 읽음)
    const tagsArr = uniq([
      ...getSelectOrMultiNames(props, TAG_PROP),
      ...getSelectOrMultiNames(props, "Tags"),
      ...getSelectOrMultiNames(props, "Tag"),
    ]);

    // ── 본문 MD
    let contentMd = await pageToMarkdown(pageId);

    // ── 자산 경로
    // 기존 파일이 있으면 fm.img_path를 재사용(가능하면), 없으면 새 경로
    const existingFile = findExistingPostFileByNotionIdOrSlug(pageId, slug);
    let existingFm = {};
    if (existingFile) {
      try {
        existingFm = readFrontMatter(existingFile).fm || {};
      } catch {}
    }

    const imgPathFront =
      existingFm.img_path || `/${ASSET_DIR}/${year}/${slug}/`;
    const postAssetDir = path.join(ASSET_DIR, year, slug);
    ensureDir(postAssetDir);

    // ── cover 처리(노션 cover 다운로드)
    let coverFileName = null;
    let coverAlt = "";
    if (DOWNLOAD_COVER && page.cover) {
      const coverUrl = page.cover?.file?.url || page.cover?.external?.url;
      if (coverUrl) {
        const name = await saveImageFromUrl(coverUrl, postAssetDir, "cover");
        if (name) coverFileName = name;
      }
    }

    // ── 본문 내 이미지 다운로드 & 치환
    const urlPattern = /!\[([^\]]*)\]\((\s*<?([^)\s]+)>?)(?:\s+"[^"]*")?\)/g;
    let match;
    let imgIndex = 1;
    const replacements = new Map(); // url -> localName

    while ((match = urlPattern.exec(contentMd)) !== null) {
      const alt = match[1];
      const url = match[3];
      if (!/^https?:\/\//i.test(url)) continue;
      if (replacements.has(url)) continue;

      const base = `${dayjs(dateRaw).format("YYYYMMDD")}-${slug}-${String(
        imgIndex++
      ).padStart(2, "0")}`;
      const localName = await saveImageFromUrl(url, postAssetDir, base);
      if (localName) {
        replacements.set(url, localName);
        // cover 없으면 첫 이미지 대표로
        if (!coverFileName) {
          coverFileName = localName;
          coverAlt = coverAlt || alt || "";
        }
      }
    }
    for (const [from, localName] of replacements.entries()) {
      contentMd = contentMd.split(from).join(`{{ page.img_path }}${localName}`);
    }

    // ── Front Matter 구성(필요 필드만)
    const fmObj = {
      title,
      date: existingFm.date || dateForFrontMatter, // 기존 파일이 있으면 날짜 유지(수정 시 permalink 안정)
      img_path: imgPathFront,
      image: coverFileName ? { path: coverFileName, alt: coverAlt } : undefined,
      categories: categoriesArr.length ? categoriesArr : undefined,
      tags: tagsArr.length ? tagsArr : undefined,
      notion_id: pageId,
      notion_last_edited: page.last_edited_time,
      // tags/categories/author/math/toc 등이 필요하면 아래에 추가 가능
    };
    // 빈 키 제거
    Object.keys(fmObj).forEach((k) => {
      const v = fmObj[k];
      if (
        v === undefined ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "string" && v.trim() === "")
      ) {
        delete fmObj[k];
      }
    });

    const fmYaml = yaml.dump(fmObj, { lineWidth: 100 });
    const finalMd = `---\n${fmYaml}---\n\n${contentMd}\n`;

    // ── 저장 경로: 기존 파일이 있으면 그대로 덮어쓰기, 아니면 "YYYY-MM-DD-slug.md"
    const targetPath =
      existingFile || path.join(POSTS_DIR, `${dateForFile}-${slug}.md`);

    // 덮어쓰기(변경 없으면 스킵)
    let needWrite = true;
    if (fs.existsSync(targetPath)) {
      const prev = fs.readFileSync(targetPath, "utf8");
      if (prev === finalMd) needWrite = false;
    }
    if (needWrite) {
      fs.writeFileSync(targetPath, finalMd, "utf8");
      console.log(`✅ Updated: ${targetPath}`);
      changed++;
    } else {
      console.log(`↔  No change: ${targetPath}`);
    }

    // ── 배포 체크박스 자동 해제(요구사항 2)
    try {
      await notion.pages.update({
        page_id: pageId,
        properties: { [DEPLOY_PROP]: { checkbox: false } },
      });
      console.log(`🔓 Unchecked '${DEPLOY_PROP}' for page ${pageId}`);
    } catch (e) {
      console.warn(
        `⚠️ Failed to uncheck '${DEPLOY_PROP}' for ${pageId}: ${e.message}`
      );
    }
  }

  console.log(`\nDone. ${changed} file(s) updated.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
