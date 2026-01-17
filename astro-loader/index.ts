import type { LiveLoader } from 'astro/loaders';

interface Article {
  id: string;
  title: string;
  content: string;
  author: string;
}

export function documentLoader(config: { 
  apiKey: string,
  host: string,
  spaceId: string,
}): LiveLoader<Article> {
  return {
    name: 'wiki-loader',
    loadCollection: async ({ filter }) => {
      const url = `${config.host}/api/v1/spaces/${config.spaceId}/categories/${filter?.collectionSlug}/documents`;
      
      try {
        const response = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${config.apiKey}`
          }
        });
        
        if (!response.ok) {
          return {
            error: new Error('Article could not be loaded'),
          };
        }
        
        const category = await response.json();

        return {
          entries: category.documents.map((doc: any) => ({
            id: doc.id,
            data: doc,
          })),
        };
      } catch (error) {
        return {
          error: new Error(`Failed to load articles: ${error.message}`),
        };
      }
    },
    loadEntry: async ({ filter }) => {
      const url = `${config.host}/api/v1/spaces/${config.spaceId}/documents/${filter.id}`;
      
      try {
        const response = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${config.apiKey}`
          }
        });

        if (!response.ok) {
          return {
            error: new Error('Article could not be loaded'),
          };
        }
        
        const doc = await response.json();

        return {
          id: doc.id,
          data: doc.properties,
          rendered: {
            html: doc.content,
          },
        };
      } catch (error) {
        return {
          error: new Error(`Failed to load article: ${error.message}`),
        };
      }
    },
  };
}