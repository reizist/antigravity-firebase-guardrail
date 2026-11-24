# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}
