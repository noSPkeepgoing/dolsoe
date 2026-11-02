# 돌쇠 (dolsoe)

텔레그램 승인형 블로그 수익화 자동화 봇입니다. 매일 아침 8시(KST)에 책(YES24) 초안을 만들어 텔레그램으로 보내고,
쿠팡 링크를 보내면 가전 리뷰 초안을 즉시 만듭니다. 사람이 텔레그램에서 `발행`을 누르면 네이버 블로그 **임시저장함**에 글이
들어갑니다. 공개 발행은 사람이 네이버에서 직접 합니다.

```
텔레그램 ⇄ 봇(grammY 롱폴링) ─┬─ 초안 생성(Claude API + 웹검색) ─ YES24 / 쿠팡 링크
                              ├─ 스케줄러(60초 tick, 매일 08:00 KST)
                              └─ 발행: ③ 네이버 임시저장(Playwright) → ④ 텔레그램 전달(폴백)
                                          ↓
                                      SQLite 1파일
```

단일 Node 프로세스 하나가 봇·스케줄러·발행 워커를 모두 돌립니다(ADR-002). 맥북이 꺼져 있으면 아무것도 못 보내고,
다시 켜지면 오늘치 1편만 만들고 밀린 날은 "N일 누락" 알림만 보냅니다.

## 1. 준비물

| 항목 | 설명 |
|---|---|
| macOS 머신 | 맥북에어 등. **로그인된 화면 세션이 필요합니다**(아래 §6 참고) |
| Node.js 22 이상 | `node -v`로 확인. 권장: Homebrew `brew install node@22` |
| 텔레그램 봇 토큰 | 텔레그램 `@BotFather`에서 `/newbot`으로 발급 |
| 본인 chat_id | 봇에게 아무 말이나 건 뒤 `https://api.telegram.org/bot<토큰>/getUpdates`의 `message.chat.id` |
| Anthropic API 키 | https://console.anthropic.com — 초안 생성·웹검색에 사용 |
| YES24 API 키 | YES24 OpenAPI에서 발급(무료). 애드온 신청은 이미 완료(해제 불가) |
| 네이버 계정 | 블로그가 개설된 계정. 임시저장용 전용 브라우저 프로필에 1회 로그인 |

## 2. 코드와 데이터 옮기기

이 저장소에는 원격(remote)이 설정돼 있지 않습니다. 아래 둘 중 하나로 옮기세요.

**A. 원격 저장소를 만들어 push/clone (권장)**
```bash
# 기존 맥에서 — GitHub 비공개 저장소를 만든 뒤
git remote add origin git@github.com:<계정>/dolsoe.git
git push -u origin main

# 새 맥북에어에서
git clone git@github.com:<계정>/dolsoe.git ~/dolsoe
```

**B. 폴더째 복사 (rsync)**
```bash
# 기존 맥에서 실행. node_modules와 data는 빼고 복사한다
rsync -av --exclude node_modules --exclude data --exclude .claude --exclude .omc \
  ~/seonpa/dolsoe/ <사용자>@<맥북에어>.local:~/dolsoe/
```

`.env`와 `data/`는 git에 올라가지 않습니다(`.gitignore`). 아래대로 따로 처리합니다.

### 기존 데이터를 이어받을지 결정

| 대상 | 이어받기 | 비고 |
|---|---|---|
| `data/dolsoe.db` | 선택 | 초안·발행 이력·월 비용 누적·중복 제외 기록이 들어 있습니다. 새로 시작해도 되지만, 이미 쓴 책을 또 고를 수 있습니다 |
| `data/media/` | 선택 | 아직 끝나지 않은 초안의 "내 한 컷" 사진. 기동 시 고아 파일은 자동 정리됩니다 |
| `data/naver-profile/` | **복사하지 말고 새로 로그인** | 크롬 계열 프로필의 쿠키는 머신의 키체인으로 암호화돼 다른 맥에선 보통 읽히지 않습니다. §5에서 다시 로그인하세요 |

DB를 옮길 때는 **기존 맥의 봇을 먼저 완전히 멈춘 뒤** 복사합니다(WAL 파일 때문에 실행 중 복사하면 깨질 수 있습니다).
같은 봇 토큰으로 두 곳에서 동시에 롱폴링하면 서로 업데이트를 뺏어 `409 Conflict`가 나므로, 옮기는 순간부터는 한쪽만 켜야 합니다.

```bash
# 기존 맥에서
sqlite3 data/dolsoe.db "PRAGMA wal_checkpoint(TRUNCATE);"   # WAL을 본 파일에 합치기
scp data/dolsoe.db <사용자>@<맥북에어>.local:~/dolsoe/data/
rsync -av data/media/ <사용자>@<맥북에어>.local:~/dolsoe/data/media/   # 선택
```

## 3. 설치

```bash
cd ~/dolsoe
mkdir -p data/logs
npm ci
npx playwright install chromium     # 네이버 임시저장용 브라우저(최초 1회, 수백 MB)
```

`better-sqlite3`는 네이티브 모듈입니다. 설치가 실패하면 `xcode-select --install`로 명령줄 도구를 먼저 설치하세요.
기존 맥과 CPU 종류(Intel/Apple Silicon)가 다르더라도 `node_modules`는 복사하지 말고 반드시 새 머신에서 `npm ci` 하세요.

## 4. 환경 변수 (`.env`)

```bash
cp .env.example .env
chmod 600 .env          # 비밀값이므로 본인만 읽도록
```

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC...      # 필수
OWNER_CHAT_ID=123456789               # 필수. 이 chat_id 외의 메시지는 전부 무시됩니다(REQ-014)
ANTHROPIC_API_KEY=sk-ant-...          # 필수(없으면 기동 실패)
YES24_API_KEY=...                     # 필수(없으면 기동 실패)
NAVER_PROFILE_DIR=data/naver-profile  # 선택. 켜면 네이버 임시저장, 비우면 텔레그램 전달만
DB_PATH=data/dolsoe.db                # 기본값
#MEDIA_DIR=data/media                 # 기본값
```

- 상대 경로는 **실행 디렉터리(프로젝트 루트) 기준**입니다. launchd 설정에서 `WorkingDirectory`를 반드시 프로젝트 루트로 두세요.
- 네이버 임시저장 없이 텔레그램 전달만 쓰려면 `NAVER_PROFILE_DIR` 줄을 지우거나 주석 처리합니다. §5는 건너뛰어도 됩니다.

## 5. 네이버 로그인 (최초 1회)

`NAVER_PROFILE_DIR`를 켰다면, 맥북 **화면 앞에서** 직접 로그인합니다. 비밀번호는 코드가 다루지 않고 세션만 프로필 폴더에 남습니다.

```bash
npm run naver:login
```

Chromium 창이 열리면 네이버에 로그인하세요. **"로그인 상태 유지"를 반드시 체크**합니다. 2단계 인증이 있으면 이 창에서 통과합니다.
글쓰기 화면(`blog.naver.com`)이 열리면 5초 뒤 창이 자동으로 닫히고 `프로필 저장 완료`가 출력됩니다.

세션이 만료되면(임시저장이 로그인 문제로 실패하고 텔레그램으로 전달됨) 같은 명령을 다시 실행하세요. 만료까지 얼마나 걸리는지는
아직 관찰 중이므로, 처음 며칠은 임시저장함에 글이 잘 들어오는지 확인하세요.

## 6. 먼저 눈으로 확인 (포그라운드 실행)

launchd에 올리기 전에 터미널에서 한 번 돌려 봅니다.

```bash
npm run start
# [dolsoe] starting (long polling + scheduler)   ← 이 줄이 나오면 정상
```

텔레그램에서 봇에게 `/ping`을 보내 `pong`이 오는지 확인합니다. 그다음 동작 점검:

1. **링크 모드**: 쿠팡 상품 링크를 보내고 **다음 줄에 상품명(+가격)** 을 적습니다. 예)
   ```
   https://link.coupang.com/a/xxxx
   로보락 S8 로봇청소기 799,000원
   ```
   잠시 뒤 초안 카드(`발행/수정/폐기` 버튼)가 옵니다.
2. **발행**: `발행` 버튼 → 약 10초 뒤 "네이버 임시저장 완료" 알림 → 네이버 블로그 **임시저장함**에서 글 확인.
3. **일일 초안**: 매일 08:00 KST에 책 초안이 자동으로 옵니다. 기동 시각이 08:00 이후이고 오늘 시도 기록이 없으면 기동 직후 오늘치 1편이 만들어집니다.

확인되면 `Ctrl+C`로 종료하세요(`SIGINT`를 받으면 봇과 DB를 정리하고 종료합니다).

## 7. 상시 구동 (launchd)

핵심: 돌쇠는 네이버 임시저장에 **화면이 있는(헤드풀) Chromium** 을 띄웁니다(`headless: false`). 그래서 시스템 전체
`LaunchDaemon`이 아니라 **로그인한 사용자의 `LaunchAgent`** 로 등록해야 합니다. 화면 세션이 없으면 브라우저를 못 띄워
임시저장이 실패하고 텔레그램 전달로 내려갑니다.

### 7-1. 경로 확인

```bash
which node                       # 예) /opt/homebrew/bin/node
cd ~/dolsoe && pwd               # 예) /Users/<사용자>/dolsoe
ls node_modules/tsx/dist/cli.mjs # tsx 실행 파일 존재 확인
```

### 7-2. plist 작성

아래 `__NODE_BIN__`, `__PROJECT_DIR__`를 위에서 확인한 **절대경로**로 바꿔 `~/Library/LaunchAgents/com.dolsoe.bot.plist`로 저장합니다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dolsoe.bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE_BIN__</string>
    <string>__PROJECT_DIR__/node_modules/tsx/dist/cli.mjs</string>
    <string>__PROJECT_DIR__/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__PROJECT_DIR__</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>__PROJECT_DIR__/data/logs/bot.out.log</string>
  <key>StandardErrorPath</key>
  <string>__PROJECT_DIR__/data/logs/bot.err.log</string>
</dict>
</plist>
```

- `KeepAlive`: 프로세스가 죽으면 launchd가 다시 띄웁니다. `ThrottleInterval`은 설정 오류로 즉시 죽을 때 재시작 폭주를 막습니다.
- `.env`는 `WorkingDirectory` 기준으로 `dotenv`가 읽으므로 plist에 비밀값을 넣지 않습니다.
- `ProgramArguments`의 node 경로는 Homebrew(Apple Silicon)면 `/opt/homebrew/bin/node`, Intel이면 `/usr/local/bin/node`입니다.

### 7-3. 등록·확인·재시작·해제

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dolsoe.bot.plist   # 등록 + 시작
launchctl print gui/$(id -u)/com.dolsoe.bot | head -20                         # state = running 확인
tail -f ~/dolsoe/data/logs/bot.out.log                                         # "[dolsoe] starting" 확인

launchctl kickstart -k gui/$(id -u)/com.dolsoe.bot       # 재시작(코드·.env 수정 후)
launchctl bootout gui/$(id -u)/com.dolsoe.bot            # 중지 + 해제
```

plist를 수정했다면 `bootout` 후 다시 `bootstrap` 해야 반영됩니다. 코드 업데이트 후에는 아래처럼 합니다.

```bash
cd ~/dolsoe && git pull && npm ci && launchctl kickstart -k gui/$(id -u)/com.dolsoe.bot
```

## 8. 맥북에어를 홈서버로 쓰기 위한 설정

launchd만으로는 부족합니다. 8시에 맥이 자고 있으면 초안이 안 옵니다.

1. **자동 로그인**: 시스템 설정 → 사용자 및 그룹 → 자동 로그인을 본인 계정으로. 재부팅 후에도 LaunchAgent가 뜨려면 로그인 세션이 필요합니다.
   FileVault가 켜져 있으면 자동 로그인이 불가능합니다. 이 경우 재부팅 후 한 번은 직접 로그인해야 합니다.
2. **잠자기 방지**: 시스템 설정 → 배터리/에너지 절약에서 "전원 어댑터 연결 시 자동 잠자기 방지"를 켭니다. 터미널로는:
   ```bash
   sudo pmset -c sleep 0 disksleep 0      # 어댑터 연결 중엔 시스템 잠자기 안 함 (화면은 꺼져도 됨)
   sudo pmset -c womp 1                   # (선택) 네트워크 깨우기
   pmset -g                               # 설정 확인
   ```
3. **덮개**: 맥북은 덮개를 닫으면 기본적으로 잠듭니다. 가장 단순한 방법은 **덮개를 연 채 밝기를 0으로** 두는 것입니다.
   덮개를 닫고 운영하려면 전원 어댑터 + 외부 모니터·키보드(또는 마우스)를 연결한 클램셸 모드여야 합니다. 이 조건이 아니면
   `pmset` 설정과 무관하게 덮개를 닫는 순간 잠자기에 들어갑니다.
4. **화면 잠금**: 화면이 잠겨 있어도 로그인 세션은 살아 있어 헤드풀 Chromium은 뜹니다. 다만 로그아웃하면 안 됩니다.
5. **네트워크**: 공유기 DHCP 예약 등 고정 IP는 필수는 아니지만(봇은 아웃바운드 롱폴링만 씁니다, 포트 개방 불필요) Wi-Fi 절전은 꺼 두세요.
6. **macOS 업데이트 자동 재시작**: 자동 업데이트가 재부팅하면 1번(자동 로그인)이 없을 때 봇이 멈춥니다. 업데이트는 직접 하는 쪽을 권합니다.

## 9. 운영 중 확인할 것

| 증상 | 확인 |
|---|---|
| 봇이 응답 없음 | `/ping` → 무응답이면 `launchctl print ...` 로 state 확인, `data/logs/bot.err.log` 확인 |
| `409 Conflict` 로그 | 같은 봇 토큰으로 다른 곳(기존 맥, 포그라운드 `npm start`)이 돌고 있음 → 한쪽 종료 |
| 시작하자마자 죽음 | `Invalid environment — ...` 또는 `Missing required environment ...` 로그 → `.env` 누락 확인 |
| 임시저장이 아니라 텔레그램으로 전달됨 | 네이버 세션 만료 → `npm run naver:login`. 또는 로그인된 화면 세션이 없음(§7, §8) |
| 08:00에 초안이 안 옴 | 맥이 잠자기 상태였는지(§8), 월 비용 상한 도달 알림이 없었는지 확인. 기동 시 "누락 N일" 알림이 옵니다 |
| 초안이 책만 옴 | 정상. 가전은 쿠팡 링크를 보낼 때만 만들어집니다 |

- **월 비용**: LLM·웹검색 사용량이 DB에 누적되고 상한(월 약 1만원) 근처에서 텔레그램으로 알립니다. 책 1편당 후기·필사 수집 포함 약 300원 수준입니다.
- **로그 크기**: `data/logs/*.log`는 계속 커집니다. 가끔 `: > data/logs/bot.out.log`로 비우거나 `newsyslog`로 순환하세요.
- **백업**: 중요한 건 `data/dolsoe.db` 하나입니다. 실행 중에는 `sqlite3 data/dolsoe.db ".backup '/백업/경로/dolsoe-$(date +%F).db'"` 로 안전하게 복사하세요.
- **네이버 임시저장함 정리**: 테스트로 생긴 글은 직접 삭제하세요. 공개 발행은 임시저장함에서 사람이 합니다.

## 10. 개발 명령

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest
bash scripts/gate.sh  # 위 세 가지 + 요구사항(REQ) 추적성 검증
```

설계·결정 문서: `docs/PRD.md`(요구사항), `docs/PLAN.md`(진행 상태), `docs/adr/`(결정 기록), `docs/contract/domain.ts`(도메인 계약).
