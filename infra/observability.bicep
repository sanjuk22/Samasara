targetScope = 'resourceGroup'

param location string
param environment string
param workspaceName string
param applicationInsightsName string
param retentionInDays int
param totalRetentionInDays int
param archiveRetentionInDays int
param alertEmail string
param deployRoleAssignments bool
param eventPublisherPrincipalIds array
param tags object

var suffix = take(uniqueString(subscription().id, resourceGroup().id), 8)
var runtimeIdentityName = 'id-samasara-observability-${environment}'
var dataCollectionEndpointName = 'dce-samasara-observability-${environment}'
var dataCollectionRuleName = 'dcr-samasara-observability-${environment}'
var keyVaultName = 'kv-daesobs-${suffix}'
var archiveStorageAccountName = 'stdaesobs${suffix}'
var workflowStreamName = 'Custom-SamasaraWorkflow'
var healerStreamName = 'Custom-SamasaraHealer'
var eventStreamName = 'Custom-SamasaraEvent'
var logAnalyticsReaderRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '73c42c96-874c-492b-b04d-ab87d138a893'
)
var monitoringMetricsPublisherRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)
var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

var workflowColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'Repository', type: 'string' }
  { name: 'WorkflowName', type: 'string' }
  { name: 'WorkflowRunId', type: 'string' }
  { name: 'JobName', type: 'string' }
  { name: 'EventName', type: 'string' }
  { name: 'ActorHash', type: 'string' }
  { name: 'CommitSha', type: 'string' }
  { name: 'Branch', type: 'string' }
  { name: 'Status', type: 'string' }
  { name: 'Conclusion', type: 'string' }
  { name: 'StartedAt', type: 'datetime' }
  { name: 'CompletedAt', type: 'datetime' }
  { name: 'DurationMs', type: 'long' }
  { name: 'RunUrl', type: 'string' }
  { name: 'DeliveryId', type: 'string' }
  { name: 'Payload', type: 'dynamic' }
]

var healerColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'EventName', type: 'string' }
  { name: 'Application', type: 'string' }
  { name: 'Environment', type: 'string' }
  { name: 'Repository', type: 'string' }
  { name: 'SessionId', type: 'long' }
  { name: 'StartSha', type: 'string' }
  { name: 'EndSha', type: 'string' }
  { name: 'Outcome', type: 'string' }
  { name: 'Attempts', type: 'long' }
  { name: 'TokensIn', type: 'long' }
  { name: 'TokensOut', type: 'long' }
  { name: 'DurationMs', type: 'long' }
  { name: 'Success', type: 'boolean' }
  { name: 'Payload', type: 'dynamic' }
]

var eventInputColumns = [
  { name: 'timestamp', type: 'datetime' }
  { name: 'schemaVersion', type: 'long' }
  { name: 'eventName', type: 'string' }
  { name: 'application', type: 'string' }
  { name: 'environment', type: 'string' }
  { name: 'userIdHash', type: 'string' }
  { name: 'sessionId', type: 'string' }
  { name: 'traceId', type: 'string' }
  { name: 'sourceTimestamp', type: 'datetime' }
  { name: 'route', type: 'string' }
  { name: 'feature', type: 'string' }
  { name: 'result', type: 'string' }
  { name: 'durationMs', type: 'long' }
  { name: 'repository', type: 'string' }
  { name: 'workflowName', type: 'string' }
  { name: 'workflowRunId', type: 'string' }
  { name: 'commitSha', type: 'string' }
  { name: 'model', type: 'string' }
  { name: 'promptTokens', type: 'long' }
  { name: 'completionTokens', type: 'long' }
  { name: 'totalTokens', type: 'long' }
  { name: 'questionHash', type: 'string' }
  { name: 'attributes', type: 'dynamic' }
]

var eventColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'SchemaVersion', type: 'long' }
  { name: 'EventName', type: 'string' }
  { name: 'Application', type: 'string' }
  { name: 'Environment', type: 'string' }
  { name: 'UserIdHash', type: 'string' }
  { name: 'SessionId', type: 'string' }
  { name: 'TraceId', type: 'string' }
  { name: 'SourceTimestamp', type: 'datetime' }
  { name: 'Route', type: 'string' }
  { name: 'Feature', type: 'string' }
  { name: 'Result', type: 'string' }
  { name: 'DurationMs', type: 'long' }
  { name: 'Repository', type: 'string' }
  { name: 'WorkflowName', type: 'string' }
  { name: 'WorkflowRunId', type: 'string' }
  { name: 'CommitSha', type: 'string' }
  { name: 'Model', type: 'string' }
  { name: 'PromptTokens', type: 'long' }
  { name: 'CompletionTokens', type: 'long' }
  { name: 'TotalTokens', type: 'long' }
  { name: 'QuestionHash', type: 'string' }
  { name: 'Attributes', type: 'dynamic' }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    RetentionInDays: retentionInDays
  }
}

resource workflowTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: workspace
  name: 'SamasaraWorkflow_CL'
  properties: {
    plan: 'Analytics'
    retentionInDays: retentionInDays
    totalRetentionInDays: totalRetentionInDays
    schema: {
      name: 'SamasaraWorkflow_CL'
      columns: workflowColumns
    }
  }
}

resource healerTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: workspace
  name: 'SamasaraHealer_CL'
  properties: {
    plan: 'Analytics'
    retentionInDays: retentionInDays
    totalRetentionInDays: totalRetentionInDays
    schema: {
      name: 'SamasaraHealer_CL'
      columns: healerColumns
    }
  }
}

resource eventTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: workspace
  name: 'SamasaraEvent_CL'
  properties: {
    plan: 'Analytics'
    retentionInDays: retentionInDays
    totalRetentionInDays: totalRetentionInDays
    schema: {
      name: 'SamasaraEvent_CL'
      columns: eventColumns
    }
  }
}

resource dataCollectionEndpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: dataCollectionEndpointName
  location: location
  tags: tags
  properties: {
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: dataCollectionRuleName
  location: location
  kind: 'Direct'
  tags: tags
  properties: {
    dataCollectionEndpointId: dataCollectionEndpoint.id
    streamDeclarations: {
      '${workflowStreamName}': {
        columns: workflowColumns
      }
      '${healerStreamName}': {
        columns: healerColumns
      }
      '${eventStreamName}': {
        columns: eventInputColumns
      }
    }
    destinations: {
      logAnalytics: [
        {
          name: 'sharedWorkspace'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [workflowStreamName]
        destinations: ['sharedWorkspace']
        transformKql: 'source'
        outputStream: 'Custom-SamasaraWorkflow_CL'
      }
      {
        streams: [healerStreamName]
        destinations: ['sharedWorkspace']
        transformKql: 'source'
        outputStream: 'Custom-SamasaraHealer_CL'
      }
      {
        streams: [eventStreamName]
        destinations: ['sharedWorkspace']
        transformKql: 'source | project TimeGenerated=timestamp, SchemaVersion=schemaVersion, EventName=eventName, Application=application, Environment=environment, UserIdHash=userIdHash, SessionId=sessionId, TraceId=traceId, SourceTimestamp=sourceTimestamp, Route=route, Feature=feature, Result=result, DurationMs=durationMs, Repository=repository, WorkflowName=workflowName, WorkflowRunId=workflowRunId, CommitSha=commitSha, Model=model, PromptTokens=promptTokens, CompletionTokens=completionTokens, TotalTokens=totalTokens, QuestionHash=questionHash, Attributes=attributes'
        outputStream: 'Custom-SamasaraEvent_CL'
      }
    ]
  }
  dependsOn: [
    workflowTable
    healerTable
    eventTable
  ]
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runtimeIdentityName
  location: location
  tags: tags
}

resource workspaceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignments) {
  name: guid(workspace.id, runtimeIdentity.id, logAnalyticsReaderRoleId)
  scope: workspace
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: logAnalyticsReaderRoleId
  }
}

resource collectionPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignments) {
  name: guid(dataCollectionRule.id, runtimeIdentity.id, monitoringMetricsPublisherRoleId)
  scope: dataCollectionRule
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringMetricsPublisherRoleId
  }
}

resource eventPublishers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in eventPublisherPrincipalIds: if (deployRoleAssignments) {
  name: guid(dataCollectionRule.id, principalId, monitoringMetricsPublisherRoleId)
  scope: dataCollectionRule
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringMetricsPublisherRoleId
  }
}]

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource keyVaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignments) {
  name: guid(keyVault.id, runtimeIdentity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource archiveStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: archiveStorageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: { enabled: true }
        file: { enabled: true }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: archiveStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource questionArchive 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'ai-question-archive'
  properties: {
    publicAccess: 'None'
  }
}

resource questionArchivePolicy 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: questionArchive
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: archiveRetentionInDays
  }
}

resource archiveWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignments) {
  name: guid(archiveStorage.id, runtimeIdentity.id, storageBlobDataContributorRoleId)
  scope: archiveStorage
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource alertActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
  name: 'ag-samasara-observability-${environment}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'Samasara'
    enabled: true
    emailReceivers: [
      {
        name: 'Samasara operators'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource healerFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!empty(alertEmail)) {
  name: 'alert-samasara-healer-failures-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Samasara healer failures (${environment})'
    description: 'A healer session ended in a human-action outcome.'
    enabled: true
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [workspace.id]
    targetResourceTypes: ['Microsoft.OperationalInsights/workspaces']
    autoMitigate: false
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'SamasaraHealer_CL | where Outcome in ("reverted", "gave_up", "denied_policy", "budget", "error", "head_moved")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [alertActionGroup.id]
    }
  }
  dependsOn: [healerTable]
}

resource workflowFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!empty(alertEmail)) {
  name: 'alert-samasara-workflow-failures-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Tracked workflow failures (${environment})'
    description: 'A tracked GitHub workflow reported failure.'
    enabled: true
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [workspace.id]
    targetResourceTypes: ['Microsoft.OperationalInsights/workspaces']
    autoMitigate: false
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: 'SamasaraWorkflow_CL | where Conclusion in ("failure", "timed_out", "cancelled", "action_required", "startup_failure")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [alertActionGroup.id]
    }
  }
  dependsOn: [workflowTable]
}

output workspaceResourceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output applicationInsightsResourceId string = applicationInsights.id
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
output dataCollectionRuleResourceId string = dataCollectionRule.id
output dataCollectionRuleImmutableId string = dataCollectionRule.properties.immutableId
output logsIngestionEndpoint string = dataCollectionEndpoint.properties.logsIngestion.endpoint
output runtimeIdentityResourceId string = runtimeIdentity.id
output keyVaultName string = keyVault.name
output archiveStorageAccountName string = archiveStorage.name
