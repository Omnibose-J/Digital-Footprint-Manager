# 서비스별 탈퇴 / 계정삭제 링크 모음 (Phase 2용)

> 이 파일은 "탈퇴" 버튼에 연결할 링크를 정리한 참고 자료입니다.
> Cursor에게 "이 파일의 매핑을 참고해서 각 서비스의 탈퇴 버튼에 링크를 연결해줘"라고 시키면 됩니다.

## ⚠️ 사용 전 꼭 읽기

- 탈퇴 URL은 서비스마다 자주 바뀌므로 **100% 정확하지 않을 수 있습니다.**
- 그래서 아래처럼 **3단계(type)**로 구분했습니다:
  - **`direct`** : 계정 삭제/해지 페이지로 바로 연결 (가장 정확)
  - **`settings`** : 계정 설정 페이지까지만 연결 (사용자가 거기서 '삭제'를 직접 찾아야 함)
  - **`search`** : 안정적인 링크가 없어, "○○ 계정 삭제 방법" 구글 검색으로 연결
- 링크를 열면 대부분 **로그인**을 다시 요구합니다 (보안상 정상).
- 실제 삭제는 각 사이트에서 사용자가 최종 확인해야 합니다. 이 서비스는 **길 안내**만 합니다.

---

## 도메인 → 링크 매핑 (사람이 읽는 표)

| 서비스 | 매칭 도메인 | type | 링크 |
|---|---|---|---|
| Google | google.com | direct | https://myaccount.google.com/deleteaccount |
| GitHub | github.com | direct | https://github.com/settings/admin |
| Notion | notion.so | settings | https://www.notion.so/my-account |
| Canva | canva.com | settings | https://www.canva.com/settings/ |
| Vercel | vercel.com | settings | https://vercel.com/account |
| Replit | replit.com | settings | https://replit.com/account |
| Netlify | netlify.com | settings | https://app.netlify.com/user/settings |
| Figma | figma.com | settings | https://www.figma.com/settings |
| Supabase | supabase.com | settings | https://supabase.com/dashboard/account/me |
| OpenAI / ChatGPT | openai.com | direct | https://privacy.openai.com/ |
| Anthropic / Claude | claude.com, anthropic.com | search | https://www.google.com/search?q=claude+anthropic+account+deletion |
| Perplexity | perplexity.ai | settings | https://www.perplexity.ai/settings/account |
| Hugging Face | huggingface.co | settings | https://huggingface.co/settings/account |
| Midjourney | midjourney.com | search | https://www.google.com/search?q=midjourney+delete+account |
| Dify | dify.ai | search | https://www.google.com/search?q=dify+delete+account |
| Spline | spline.design | search | https://www.google.com/search?q=spline+design+delete+account |
| Upstage | upstage.ai | search | https://www.google.com/search?q=upstage+delete+account |
| Cursor | cursor.com | settings | https://www.cursor.com/settings |
| Coursera | coursera.org | settings | https://www.coursera.org/account-settings |
| Autodesk | autodesk.com | settings | https://accounts.autodesk.com |
| Microsoft | microsoft.com | direct | https://account.live.com/closeaccount.aspx |
| Apple | apple.com | direct | https://privacy.apple.com |
| Adobe | adobe.com | settings | https://account.adobe.com/security |
| Dropbox | dropbox.com | direct | https://www.dropbox.com/account/delete |
| Zoom | zoom.us | settings | https://zoom.us/profile |
| Slack | slack.com | search | https://www.google.com/search?q=slack+delete+account |
| Spotify | spotify.com | direct | https://support.spotify.com/article/close-account/ |
| Netflix | netflix.com | direct | https://www.netflix.com/cancelplan |
| Instagram | instagram.com | direct | https://www.instagram.com/accounts/remove/request/permanent/ |
| Facebook | facebook.com | direct | https://www.facebook.com/help/delete_account |
| X (Twitter) | twitter.com, x.com | direct | https://twitter.com/settings/deactivate |
| LinkedIn | linkedin.com | direct | https://www.linkedin.com/psettings/account-management/close-submit |
| Amazon | amazon.com | direct | https://www.amazon.com/privacy/data-deletion |
| Reddit | reddit.com | settings | https://www.reddit.com/settings/ |
| Discord | discord.com | settings | https://discord.com/channels/@me |
| Naver | naver.com | direct | https://nid.naver.com/membership/leave |
| Kakao | kakao.com | settings | https://accounts.kakao.com |
| Coupang | coupang.com | search | https://www.google.com/search?q=쿠팡+회원탈퇴 |
| TikTok | tiktok.com | settings | https://www.tiktok.com/setting |

---

## 코드용 매핑 (Cursor가 그대로 쓰기 좋은 형태)

> Cursor에게: 아래 객체를 참고해서, 각 행의 도메인이 key와 일치하면 그 url을 탈퇴 버튼에 연결해줘.
> 목록에 없는 도메인은 fallback으로 `https://www.google.com/search?q=<서비스명>+delete+account` 형태의 검색 링크를 만들어줘.

```json
{
  "google.com":     { "type": "direct",   "url": "https://myaccount.google.com/deleteaccount" },
  "github.com":     { "type": "direct",   "url": "https://github.com/settings/admin" },
  "notion.so":      { "type": "settings", "url": "https://www.notion.so/my-account" },
  "canva.com":      { "type": "settings", "url": "https://www.canva.com/settings/" },
  "vercel.com":     { "type": "settings", "url": "https://vercel.com/account" },
  "replit.com":     { "type": "settings", "url": "https://replit.com/account" },
  "netlify.com":    { "type": "settings", "url": "https://app.netlify.com/user/settings" },
  "figma.com":      { "type": "settings", "url": "https://www.figma.com/settings" },
  "supabase.com":   { "type": "settings", "url": "https://supabase.com/dashboard/account/me" },
  "openai.com":     { "type": "direct",   "url": "https://privacy.openai.com/" },
  "claude.com":     { "type": "search",   "url": "https://www.google.com/search?q=claude+anthropic+account+deletion" },
  "anthropic.com":  { "type": "search",   "url": "https://www.google.com/search?q=claude+anthropic+account+deletion" },
  "perplexity.ai":  { "type": "settings", "url": "https://www.perplexity.ai/settings/account" },
  "huggingface.co": { "type": "settings", "url": "https://huggingface.co/settings/account" },
  "midjourney.com": { "type": "search",   "url": "https://www.google.com/search?q=midjourney+delete+account" },
  "dify.ai":        { "type": "search",   "url": "https://www.google.com/search?q=dify+delete+account" },
  "spline.design":  { "type": "search",   "url": "https://www.google.com/search?q=spline+design+delete+account" },
  "upstage.ai":     { "type": "search",   "url": "https://www.google.com/search?q=upstage+delete+account" },
  "cursor.com":     { "type": "settings", "url": "https://www.cursor.com/settings" },
  "coursera.org":   { "type": "settings", "url": "https://www.coursera.org/account-settings" },
  "autodesk.com":   { "type": "settings", "url": "https://accounts.autodesk.com" },
  "microsoft.com":  { "type": "direct",   "url": "https://account.live.com/closeaccount.aspx" },
  "apple.com":      { "type": "direct",   "url": "https://privacy.apple.com" },
  "adobe.com":      { "type": "settings", "url": "https://account.adobe.com/security" },
  "dropbox.com":    { "type": "direct",   "url": "https://www.dropbox.com/account/delete" },
  "zoom.us":        { "type": "settings", "url": "https://zoom.us/profile" },
  "slack.com":      { "type": "search",   "url": "https://www.google.com/search?q=slack+delete+account" },
  "spotify.com":    { "type": "direct",   "url": "https://support.spotify.com/article/close-account/" },
  "netflix.com":    { "type": "direct",   "url": "https://www.netflix.com/cancelplan" },
  "instagram.com":  { "type": "direct",   "url": "https://www.instagram.com/accounts/remove/request/permanent/" },
  "facebook.com":   { "type": "direct",   "url": "https://www.facebook.com/help/delete_account" },
  "twitter.com":    { "type": "direct",   "url": "https://twitter.com/settings/deactivate" },
  "x.com":          { "type": "direct",   "url": "https://twitter.com/settings/deactivate" },
  "linkedin.com":   { "type": "direct",   "url": "https://www.linkedin.com/psettings/account-management/close-submit" },
  "amazon.com":     { "type": "direct",   "url": "https://www.amazon.com/privacy/data-deletion" },
  "reddit.com":     { "type": "settings", "url": "https://www.reddit.com/settings/" },
  "discord.com":    { "type": "settings", "url": "https://discord.com/channels/@me" },
  "naver.com":      { "type": "direct",   "url": "https://nid.naver.com/membership/leave" },
  "kakao.com":      { "type": "settings", "url": "https://accounts.kakao.com" },
  "coupang.com":    { "type": "search",   "url": "https://www.google.com/search?q=쿠팡+회원탈퇴" },
  "tiktok.com":     { "type": "settings", "url": "https://www.tiktok.com/setting" }
}
```

---

## UI 참고 (Cursor에게 넘길 때 같이 알려주면 좋은 것)

- `direct` → 버튼 문구: **"탈퇴 페이지 열기"**
- `settings` → 버튼 문구: **"계정 설정 열기"** (+ 작은 안내: "설정 안에서 계정 삭제를 찾으세요")
- `search` → 버튼 문구: **"탈퇴 방법 찾기"**
- 모든 링크는 **새 탭**으로 열기 (`target="_blank"`, `rel="noopener noreferrer"`)
- 매핑에 없는 서비스는 자동으로 `search` 타입으로 처리
