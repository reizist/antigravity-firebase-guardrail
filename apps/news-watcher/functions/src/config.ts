// ==============================================================================
// news-watcher の設定値（テナントの名前は docs/platform_design.md §3.1 の決まりに従う）
// ==============================================================================

// 環境ごとの値（プロジェクト ID・リージョン・サイトの接頭辞）は platform/config.json の 1 か所で決める。
// esbuild がビルド時にこの JSON をバンドルに埋め込む
import platform from "../../../../platform/config.json" with { type: "json" };

export const APP_ID = "news-watcher";

/** Firestore の DB 名（テナントごとに専用の DB） */
export const DATABASE_ID = "news-watcher";

export const REGION: string = platform.region;

/** 共有プロジェクト（テナントの置き場所） */
export const PROJECT_ID: string = platform.project_id;

/** 画面の URL（Hosting サイト <site_prefix>-<app>） */
export const APP_URL = `https://${platform.site_prefix}-${APP_ID}.web.app`;

/**
 * 実行 SA。メールアドレスをすべて書く。
 * `app-news-watcher@` と省略しても関数は作れるが、firebase-tools がシークレットの権限を確認するときに展開せずに使うため、
 * Terraform で付けた権限と一致せず、自分で付けようとして失敗する（docs/news_watcher_design.md §8.1）
 */
export const RUNTIME_SERVICE_ACCOUNT = `app-${APP_ID}@${PROJECT_ID}.iam.gserviceaccount.com`;

/** 関数・Vertex AI のリクエストに付けるラベル（費用の集計に使う） */
export const LABELS: Record<string, string> = { app: APP_ID };

export const TIME_ZONE = "Asia/Tokyo";

/**
 * 配信先の Webhook URL を入れるシークレット（台帳 platform/catalog/apps.yaml の secrets と一致させる）。
 * Functions はシークレットを静的に宣言する必要があるため、channels/{id}.secretName はこの中から選ぶ。
 */
export const WEBHOOK_SECRET_NAMES = ["NEWS_WATCHER_SLACK_WEBHOOK_GENERAL"] as const;

/** Webhook の送信先として認めるホスト（これ以外の URL には送らない） */
export const ALLOWED_WEBHOOK_HOSTS = ["chat.googleapis.com", "hooks.slack.com"] as const;

export const LIMITS = {
  /** 1 回の取得で Gemini に採点させる件数の上限（トピックごと。docs/news_watcher_design.md §5.5） */
  maxArticlesPerRun: 50,
  /** 1 つの情報源から 1 回に読む記事の上限 */
  maxItemsPerSource: 30,
  /** 1 回の取得で同じドメインにアクセスする上限 */
  maxRequestsPerDomain: 5,
  fetchTimeoutMs: 10_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  /** 1 回のまとめ配信に載せる記事の上限（トピックの maxItemsPerDigest がなければこれ） */
  maxItemsPerDigest: 10,
  /** 記事を保存しておく日数（Firestore TTL の expireAt） */
  articleRetentionDays: 90,
  /** まとめ配信の対象にする記事の新しさ（日） */
  digestLookbackDays: 7,
} as const;

/** config/app.geminiModel がなければこのモデルを使う */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export const USER_AGENT = `news-watcher/0.1 (internal news digest; +${APP_URL})`;
