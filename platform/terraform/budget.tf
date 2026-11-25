# ==============================================================================
# 予算アラート（初回構築で作る。platform/config.json の enable_budgets = false で作らない）
#   - 共有プロジェクト全体の月額予算（実績 50% / 90% / 100%、予測 100%）
#   - アプリごとの予算（ラベル app=<id> で絞り込む。台帳に budget_jpy があるアプリだけ）
#     ラベルが付かない費用（Hosting・Firestore など）はアプリ別には出ないので、プロジェクト全体の予算で見る
#   - 通知先: Pub/Sub トピック fga-budget-alerts・メール（budget_alert_emails）・課金アカウントの管理者
#
# 予算アラートは「通知」だけで、課金は止まらない。共有プロジェクトの課金アカウントを外すと、
# 同居する全アプリが止まる。止めるなら Pub/Sub を購読して該当アプリの関数だけを止める。
# 上限そのものは、関数の maxInstances と API のクォータで決める（docs/platform_design.md §3.4）。
#
# 予算の作成には、課金アカウント側の権限（billing.budgets.create）が要る。
# bootstrap が Terraform SA に roles/billing.costsManager を付ける（付けられない環境は enable_budgets = false）。
# ==============================================================================

resource "google_pubsub_topic" "budget_alerts" {
  count   = local.enable_budgets ? 1 : 0
  project = local.project_id
  name    = "fga-budget-alerts"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "budget_email" {
  for_each     = local.enable_budgets ? toset(local.budget_alert_emails) : toset([])
  project      = local.project_id
  display_name = "予算アラート（${each.value}）"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.apis]
}

resource "google_billing_budget" "project" {
  provider        = google-beta
  count           = local.enable_budgets ? 1 : 0
  billing_account = local.billing_account
  display_name    = "${local.project_id} 月額予算"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(local.project_budget_jpy)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget_alerts[0].id
    schema_version                   = "1.0"
    monitoring_notification_channels = [for ch in google_monitoring_notification_channel.budget_email : ch.id]
    disable_default_iam_recipients   = false
  }

  lifecycle {
    precondition {
      condition     = local.billing_account != ""
      error_message = "予算アラートを作る課金アカウントが分かりません。プロジェクトに課金アカウントを紐付けるか、terraform.tfvars の billing_account を指定してください（課金アカウントの権限をもらえない環境は、platform/config.json に \"enable_budgets\": false を書く）"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_billing_budget" "app" {
  provider = google-beta
  # 値は金額だけにする（台帳の項目はアプリごとに違うので、エントリそのものを値にすると型がそろわない）
  for_each        = { for id, app in local.apps : id => app.budget_jpy if local.enable_budgets && try(app.budget_jpy, null) != null }
  billing_account = local.billing_account
  display_name    = "${local.project_id} / ${each.key} 月額予算"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
    labels = {
      app = each.key
    }
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(each.value)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget_alerts[0].id
    schema_version                   = "1.0"
    monitoring_notification_channels = [for ch in google_monitoring_notification_channel.budget_email : ch.id]
    disable_default_iam_recipients   = false
  }

  lifecycle {
    precondition {
      condition     = local.billing_account != ""
      error_message = "予算アラートを作る課金アカウントが分かりません（google_billing_budget.project のメッセージを参照）"
    }
  }

  depends_on = [google_project_service.apis]
}
