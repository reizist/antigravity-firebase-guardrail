# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # Firebase の一部のリソース（firebase_project / web_app / hosting_site）は beta プロバイダのみ対応
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}
