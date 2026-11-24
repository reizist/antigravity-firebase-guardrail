# tfstate は bootstrap が作るバケット <project_id>-tfstate に置く。
# バケット名は init のときに渡す（scripts/deploy_platform.sh と CI が platform/config.json から組み立てる）:
#   terraform init -backend-config="bucket=<project_id>-tfstate"
terraform {
  backend "gcs" {
    prefix = "platform/state"
  }
}
