/**
 * Domain → account-cancel link map (docs/service-cancel-urls.md).
 * Unlisted domains fall back to a Google search.
 */

export const CANCEL_LABEL = {
  direct: "탈퇴 페이지 열기",
  settings: "계정 설정 열기",
  search: "탈퇴 방법 찾기",
};

/** @type {Record<string, { type: "direct"|"settings"|"search", url: string }>} */
export const CANCEL_URLS = {
  "google.com": { type: "direct", url: "https://myaccount.google.com/deleteaccount" },
  "github.com": { type: "direct", url: "https://github.com/settings/admin" },
  "notion.so": { type: "settings", url: "https://www.notion.so/my-account" },
  "canva.com": { type: "settings", url: "https://www.canva.com/settings/" },
  "vercel.com": { type: "settings", url: "https://vercel.com/account" },
  "replit.com": { type: "settings", url: "https://replit.com/account" },
  "netlify.com": { type: "settings", url: "https://app.netlify.com/user/settings" },
  "figma.com": { type: "settings", url: "https://www.figma.com/settings" },
  "supabase.com": { type: "settings", url: "https://supabase.com/dashboard/account/me" },
  "openai.com": { type: "direct", url: "https://privacy.openai.com/" },
  "claude.com": {
    type: "search",
    url: "https://www.google.com/search?q=claude+anthropic+account+deletion",
  },
  "anthropic.com": {
    type: "search",
    url: "https://www.google.com/search?q=claude+anthropic+account+deletion",
  },
  "perplexity.ai": { type: "settings", url: "https://www.perplexity.ai/settings/account" },
  "huggingface.co": { type: "settings", url: "https://huggingface.co/settings/account" },
  "midjourney.com": {
    type: "search",
    url: "https://www.google.com/search?q=midjourney+delete+account",
  },
  "dify.ai": { type: "search", url: "https://www.google.com/search?q=dify+delete+account" },
  "spline.design": {
    type: "search",
    url: "https://www.google.com/search?q=spline+design+delete+account",
  },
  "upstage.ai": { type: "search", url: "https://www.google.com/search?q=upstage+delete+account" },
  "cursor.com": { type: "settings", url: "https://www.cursor.com/settings" },
  "coursera.org": { type: "settings", url: "https://www.coursera.org/account-settings" },
  "autodesk.com": { type: "settings", url: "https://accounts.autodesk.com" },
  "microsoft.com": { type: "direct", url: "https://account.live.com/closeaccount.aspx" },
  "apple.com": { type: "direct", url: "https://privacy.apple.com" },
  "adobe.com": { type: "settings", url: "https://account.adobe.com/security" },
  "dropbox.com": { type: "direct", url: "https://www.dropbox.com/account/delete" },
  "zoom.us": { type: "settings", url: "https://zoom.us/profile" },
  "slack.com": { type: "search", url: "https://www.google.com/search?q=slack+delete+account" },
  "spotify.com": {
    type: "direct",
    url: "https://support.spotify.com/article/close-account/",
  },
  "netflix.com": { type: "direct", url: "https://www.netflix.com/cancelplan" },
  "instagram.com": {
    type: "direct",
    url: "https://www.instagram.com/accounts/remove/request/permanent/",
  },
  "facebook.com": { type: "direct", url: "https://www.facebook.com/help/delete_account" },
  "twitter.com": { type: "direct", url: "https://twitter.com/settings/deactivate" },
  "x.com": { type: "direct", url: "https://twitter.com/settings/deactivate" },
  "linkedin.com": {
    type: "direct",
    url: "https://www.linkedin.com/psettings/account-management/close-submit",
  },
  "amazon.com": { type: "direct", url: "https://www.amazon.com/privacy/data-deletion" },
  "reddit.com": { type: "settings", url: "https://www.reddit.com/settings/" },
  "discord.com": { type: "settings", url: "https://discord.com/channels/@me" },
  "naver.com": { type: "direct", url: "https://nid.naver.com/membership/leave" },
  "kakao.com": { type: "settings", url: "https://accounts.kakao.com" },
  "coupang.com": { type: "search", url: "https://www.google.com/search?q=쿠팡+회원탈퇴" },
  "tiktok.com": { type: "settings", url: "https://www.tiktok.com/setting" },
};

/**
 * @param {string} domain
 * @param {string} serviceName
 * @returns {{ type: "direct"|"settings"|"search", url: string, label: string }}
 */
export function resolveCancelLink(domain, serviceName) {
  const key = String(domain || "")
    .toLowerCase()
    .replace(/\.$/, "");
  const mapped = key ? CANCEL_URLS[key] : null;
  if (mapped) {
    return {
      type: mapped.type,
      url: mapped.url,
      label: CANCEL_LABEL[mapped.type] || CANCEL_LABEL.search,
    };
  }
  const q = `${serviceName || key || "account"} delete account`;
  return {
    type: "search",
    url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    label: CANCEL_LABEL.search,
  };
}
