# ==============================================================================
# Firestore のデータベース作成を、その場で通知する（初回構築で作る。
# platform/config.json の enable_db_audit_alerts = false で作らない）
#   データベースの作成は、追加料金なしで必ず記録される管理アクティビティ監査ログ
#   （google.firestore.admin.v1.FirestoreAdmin.CreateDatabase）に残る。
#   標準の型に収まるアプリは承認なしでデータベースまで払い出すので、作成そのものを通知する。
#     1. データベースが作られた（台帳のオーナー・データ区分・有効期限を確かめるきっかけ）
#     2. Terraform SA 以外がデータベースを作った（台帳を通さない作成。すぐ確かめる）
#   通知先: Pub/Sub トピック fga-governance-alerts・メール（security_alert_emails）
#
# ログの一致で通知するアラート（condition_matched_log）を使う。ログベースの指標を挟むと、
# 指標を作った直後はアラートを作れず、初回の apply が失敗することがあるため。
# ==============================================================================

locals {
  create_database_log_filter = join(" AND ", [
    "log_id(\"cloudaudit.googleapis.com/activity\")",
    "protoPayload.serviceName=\"firestore.googleapis.com\"",
    "protoPayload.methodName=\"google.firestore.admin.v1.FirestoreAdmin.CreateDatabase\"",
  ])
}

resource "google_pubsub_topic" "governance_alerts" {
  count   = local.enable_db_audit_alerts ? 1 : 0
  project = local.project_id
  name    = "fga-governance-alerts"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "security_email" {
  for_each     = local.enable_db_audit_alerts ? toset(local.security_alert_emails) : toset([])
  project      = local.project_id
  display_name = "監査アラート（${each.value}）"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "governance_pubsub" {
  count        = local.enable_db_audit_alerts ? 1 : 0
  project      = local.project_id
  display_name = "監査アラート（Pub/Sub）"
  type         = "pubsub"

  labels = {
    topic = google_pubsub_topic.governance_alerts[0].id
  }

  depends_on = [google_project_service.apis]
}

# Cloud Monitoring の通知用サービスエージェントが、トピックに publish できるようにする
#   このサービスエージェントは、最初の Pub/Sub 通知チャネルを作ったときにできる（だからチャネルの後に付ける）
resource "google_pubsub_topic_iam_member" "governance_alerts_publisher" {
  count   = local.enable_db_audit_alerts ? 1 : 0
  project = local.project_id
  topic   = google_pubsub_topic.governance_alerts[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com"

  depends_on = [google_monitoring_notification_channel.governance_pubsub]
}

locals {
  governance_notification_channels = local.enable_db_audit_alerts ? concat(
    [google_monitoring_notification_channel.governance_pubsub[0].id],
    [for ch in google_monitoring_notification_channel.security_email : ch.id],
  ) : []
}

resource "google_monitoring_alert_policy" "firestore_db_created" {
  count        = local.enable_db_audit_alerts ? 1 : 0
  project      = local.project_id
  display_name = "[FGA 監査] Firestore のデータベースが作られました"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Firestore CreateDatabase"
    condition_matched_log {
      filter = local.create_database_log_filter
      label_extractors = {
        principal = "EXTRACT(protoPayload.authenticationInfo.principalEmail)"
        database  = "EXTRACT(protoPayload.resourceName)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "604800s"
  }

  notification_channels = local.governance_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      共有プロジェクト `${local.project_id}` に、新しい Firestore データベースが作られました。
      1. 台帳（`platform/catalog/apps.yaml` か `platform/catalog/self-service/`）に、このアプリのオーナー・データ区分（`data_class`）・`handles_pii: false`・有効期限（`expires`）があるか確かめてください。
      2. 個人情報・社外秘のデータを入れる予定がないか、外部への送信がないか、対応する PR を確かめてください。
    EOT
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "firestore_db_created_outside_terraform" {
  count        = local.enable_db_audit_alerts ? 1 : 0
  project      = local.project_id
  display_name = "[FGA 要確認] Terraform 以外が Firestore のデータベースを作りました"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "Terraform SA 以外による Firestore CreateDatabase"
    condition_matched_log {
      filter = "${local.create_database_log_filter} AND NOT protoPayload.authenticationInfo.principalEmail=\"${local.terraform_sa_email}\""
      label_extractors = {
        principal = "EXTRACT(protoPayload.authenticationInfo.principalEmail)"
        database  = "EXTRACT(protoPayload.resourceName)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "604800s"
  }

  notification_channels = local.governance_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      **すぐ確かめてください**：Terraform 用サービスアカウント（`${local.terraform_sa_email}`）以外が、共有プロジェクト `${local.project_id}` に Firestore データベースを直接作りました。
      - 監査ログで、作った人（`principalEmail`）とデータベースの名前を確かめてください。
      - 台帳にないデータベース（Security Rules が反映されていない）なら、削除するか、台帳に登録してください。
    EOT
  }

  depends_on = [google_project_service.apis]
}
