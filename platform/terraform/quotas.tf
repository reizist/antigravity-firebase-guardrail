# ==============================================================================
# API クォータ上限（Cloud Quotas API によるコード管理・予算アラートの補完防波堤）
#   - Cloud Billing の予算アラート単体は通知のみで課金を自動停止しないため、
#     共有プロジェクト全体の API 消費上限を Cloud Quotas で引き下げておくと、
#     想定外のループや急増時の課金上限をサービス側で物理的に抑えられる。
#   - 対象プロジェクト・リージョンで利用可能な quota_id は次で確認できる:
#       gcloud beta quotas info list --service=aiplatform.googleapis.com --project=<PROJECT_ID>
#       gcloud beta quotas info list --service=firestore.googleapis.com --project=<PROJECT_ID>
#   - var.api_quota_caps が空（既定）のときは 0 件でスキップし、terraform.tfvars で
#     対象サービスの quota_id と上限値を指定すると自動で引き下げを適用する。
# ==============================================================================

resource "google_cloud_quotas_quota_preference" "api_caps" {
  for_each = var.api_quota_caps

  parent               = "projects/${local.project_id}"
  name                 = "fga-cap-${each.key}"
  service              = each.value.service
  quota_id             = each.value.quota_id
  dimensions           = length(each.value.dimensions) > 0 ? each.value.dimensions : null
  contact_email        = var.quota_contact_email != "" ? var.quota_contact_email : null
  justification        = each.value.justification
  ignore_safety_checks = "QUOTA_DECREASE_PERCENTAGE_TOO_HIGH"

  quota_config {
    preferred_value = each.value.preferred_value
  }

  depends_on = [google_project_service.apis]
}
