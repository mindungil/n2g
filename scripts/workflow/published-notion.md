name: "Publish Notion @ KST Midnight"

on:
  schedule:
    # KST 00:00 = UTC 15:00 (전날)
    - cron: "0 15 * * *"
  workflow_dispatch: {}   # 필요시 수동 실행

permissions:
  contents: write

concurrency:
  group: "notion-publish"
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install deps
        run: |
          npm i --no-save @notionhq/client notion-to-md dayjs slugify js-yaml

      - name: Run Notion → Markdown (deploy-queue only)
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DATABASE_ID: ${{ secrets.NOTION_DATABASE_ID }}
          TIMEZONE: Asia/Seoul
          POSTS_DIR: _posts
          ASSET_DIR: assets/img/for_post
          DOWNLOAD_COVER: "true"
          # 한국어 필드명 매핑(노션 DB와 맞추세요)
          TITLE_KEYS: "제목,Title,Name"
          DATE_PROP: "생성일"
          DEPLOY_PROP: "배포"
          TAG_PROP: "태그"
          # 카테고리/저자 등은 필요시 아래 스크립트 PROP 에서 조정
        run: node scripts/notion-sync.mjs

      - name: Commit & Push if changed
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          git diff --cached --quiet || git commit -m "chore: publish (Notion deploy queue)"
          git push
