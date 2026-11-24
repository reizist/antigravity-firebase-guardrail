# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
# ==============================================================================
# 予算アラート（任意。enable_budgets = true のときだけ作る）
#   - 共有プロジェクト全体の予算
#   - アプリごとの予算（ラベル app=<id> で絞り込む。台帳の budget_jpy があるアプリだけ）
#     ラベルが付かない費用（Hosting・Firestore など）はアプリ別には出ない点に注意
# ==============================================================================

resource "google_billing_budget" "project" {
  count           = var.enable_budgets ? 1 : 0
  billing_account = var.billing_account
  display_name    = "${local.project_id} 月額予算"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.project_budget_jpy)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}

resource "google_billing_budget" "app" {
  for_each        = var.enable_budgets ? { for id, app in local.apps : id => app if try(app.budget_jpy, null) != null } : {}
  billing_account = var.billing_account
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
      units         = tostring(each.value.budget_jpy)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 1.0
  }
}
