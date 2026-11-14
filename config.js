// 設定檔：這三個值都是「公開」的，放進網頁裡是安全的（真正的保護靠 Supabase 的資料列權限）
// 留空的話，對應功能會自動隱藏，App 仍可在單機模式使用。
window.HEARD_CONFIG = {
  // Spotify 開發者後台 → 你的 App → Client ID
  SPOTIFY_CLIENT_ID: '19d421f2490440ce84b9ccd65d3d6d7d',
  // Supabase → Project Settings → API
  SUPABASE_URL: 'https://nlmjgfwzjxmulekdlhid.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sbWpnZnd6anhtdWxla2RsaGlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NDQwNDEsImV4cCI6MjEwOTUyMDA0MX0.Q5qVXEndD8X4JZCs7iw70LktEN-hn-hAIatOI-uaoFg'
};
