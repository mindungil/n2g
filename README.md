# n2g

## 개요
노션의 특정 데이터베이스에 트리거를 설정해서 github블로그에 자동 배포


- **트리거**
    - 속성 - 배포 체크박스 구현

- **자동 배포 로직**
    - 24:00에 배포 체크박스에 체크 된 것을 블로그에 포스팅 하는 워크플로우 구성
    - 이미 배포한 페이지를 재 체크했을 때는 수정 로직 발생 - 덮어쓰기 (제목으로 구분)


## 사용법
1. github.io 블로그를 구성한 레파지토리 내부에 script/notion-sync.mjs 생성
2. .github/workflows/published-notion.yml 생성

- 기존 github.io 블로그 workflow와 충돌 없이 추가적인 workflow를 구성함