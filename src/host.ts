import type React from 'react';

export interface ResourceState {
  manifest?: unknown;
  apiVersion?: string;
  kind?: string;
  metadata?: ResourceMetadata;
  status?: {observedGeneration?: number};
  error?: {message?: string; status?: number} | string;
}

export interface ResourceMetadata {
  name?: string;
  namespace?: string;
  generation?: number;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{apiVersion?: string; kind?: string; name?: string; uid?: string}>;
}

export interface ResourceExtensionProps {
  application?: ApplicationState;
  resource?: ResourceState;
  tree?: ApplicationTree;
}

export interface ApplicationState {
  metadata?: ResourceMetadata;
  spec?: {project?: string; destination?: {namespace?: string}};
}

export interface ApplicationTreeNode {
  apiVersion?: string;
  createdAt?: string;
  group?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  uid?: string;
  version?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface ApplicationTree {
  nodes?: ApplicationTreeNode[];
  orphanedNodes?: ApplicationTreeNode[];
  error?: {status?: number; message?: string} | string;
}

export interface ApplicationViewExtensionProps {
  application?: ApplicationState;
  tree?: ApplicationTree;
}

interface ExtensionsApi {
  registerAppViewExtension(
    component: React.ComponentType<ApplicationViewExtensionProps>,
    title: string,
    icon: string
  ): void;

  registerResourceExtension(
    component: React.ComponentType<ResourceExtensionProps>,
    group: string,
    kind: string,
    tabTitle: string
  ): void;
}

declare global {
  interface Window {
    extensionsAPI: ExtensionsApi;
  }
}
