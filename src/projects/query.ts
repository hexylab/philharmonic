const PROJECT_FRAGMENT = /* GraphQL */ `
  projectV2(number: $number) {
    id
    title
    items(first: $first) {
      nodes {
        id
        content {
          __typename
          ... on Issue {
            number
            title
            url
            state
            repository {
              nameWithOwner
            }
          }
        }
        fieldValues(first: 20) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field {
                __typename
                ... on ProjectV2SingleSelectField {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query ProjectItems($owner: String!, $number: Int!, $first: Int!) {
    repositoryOwner(login: $owner) {
      __typename
      ... on User {
        ${PROJECT_FRAGMENT}
      }
      ... on Organization {
        ${PROJECT_FRAGMENT}
      }
    }
  }
`;
