function slugify(value, fallback = 'field') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return Array.from(new Set(toArray(values).map(v => String(v || '').trim()).filter(Boolean)));
}

function inferInputType(field = {}) {
  const rawType = String(field.type || '').toLowerCase();
  const label = `${field.label || ''} ${field.placeholder || ''} ${field.help_text || ''}`.toLowerCase();

  if (['email', 'url', 'number', 'date', 'tel', 'checkbox', 'select', 'textarea', 'file'].includes(rawType)) {
    return rawType;
  }
  if (rawType === 'radio') return 'select';
  if (rawType === 'select-one' || rawType === 'dropdown') return 'select';
  if (rawType === 'text' || rawType === 'input') return 'text';
  if (label.includes('email')) return 'email';
  if (label.includes('phone') || label.includes('mobile') || label.includes('whatsapp')) return 'tel';
  if (label.includes('website') || label.includes('url') || label.includes('linkedin')) return 'url';
  if (label.includes('date') || label.includes('deadline')) return 'date';
  if (label.includes('how much') || label.includes('amount') || label.includes('budget') || label.includes('revenue')) return 'number';
  if (label.includes('upload') || label.includes('attach')) return 'file';
  if (label.includes('describe') || label.includes('explain') || label.includes('why ') || label.includes('summary') || label.includes('overview')) {
    return 'textarea';
  }
  return 'text';
}

function normalizeField(field = {}, sectionTitle = 'Application Details', index = 0) {
  const label = String(
    field.label ||
    field.question ||
    field.name ||
    field.id ||
    `Field ${index + 1}`
  ).trim();

  const idBase = field.id || field.name || label;
  const type = inferInputType(field);
  const options = uniqueStrings(field.options || field.values || []);
  const selectorHints = field.selectorHints || {
    name: field.name || '',
    id: field.dom_id || field.id || '',
    css: field.css || field.selector || ''
  };

  return {
    id: slugify(idBase, `field_${index + 1}`),
    label,
    type,
    required: Boolean(field.required),
    placeholder: String(field.placeholder || '').trim(),
    help_text: String(field.help_text || field.helpText || '').trim(),
    options,
    section: String(field.section || sectionTitle || 'Application Details').trim(),
    max_words: Number(field.max_words || field.maxWords || 0) || null,
    selectorHints
  };
}

function normalizeSchema(schemaInput = {}, fallbackTitle = 'Smart Application Draft') {
  const base = Array.isArray(schemaInput)
    ? { sections: [{ title: 'Application Details', fields: schemaInput }] }
    : (schemaInput || {});

  const sections = toArray(base.sections).map((section, sectionIndex) => {
    const sectionTitle = String(section.title || section.name || `Section ${sectionIndex + 1}`).trim();
    const fields = toArray(section.fields).map((field, fieldIndex) => normalizeField(field, sectionTitle, fieldIndex));

    return {
      title: sectionTitle,
      fields: fields.filter(field => field.label)
    };
  }).filter(section => section.fields.length > 0);

  return {
    title: String(base.title || fallbackTitle).trim(),
    subtitle: String(base.subtitle || 'Review and refine the AI-prepared answers before applying.').trim(),
    sections,
    required_documents: uniqueStrings(base.required_documents || base.requiredDocuments || [])
  };
}

function flattenSchema(schema = {}) {
  return toArray(schema.sections).flatMap(section => toArray(section.fields));
}

function buildInitialFormFields(schema = {}, existingValues = {}) {
  const fields = {};
  flattenSchema(schema).forEach(field => {
    fields[field.id] = existingValues[field.id] !== undefined ? existingValues[field.id] : '';
  });
  return fields;
}

function calculateCompletion(schema = {}, formFields = {}) {
  const fields = flattenSchema(schema);
  if (!fields.length) {
    return { completed_fields: [], missing_fields: [], progress: 0 };
  }

  const completed = [];
  const missing = [];

  fields.forEach(field => {
    const value = formFields[field.id];
    const isFilled = field.type === 'checkbox'
      ? value === true || value === false || value === 'true' || value === 'false'
      : String(value || '').trim().length > 0;

    if (isFilled) {
      completed.push(field.id);
    } else if (field.required) {
      missing.push(field.id);
    }
  });

  const progress = Math.round((completed.length / fields.length) * 100);
  return {
    completed_fields: completed,
    missing_fields: missing,
    progress
  };
}

function inferSchemaFromOpportunity(opportunity = {}) {
  const title = opportunity.title || 'Application Draft';
  const sectorPrompt = opportunity.sector || 'the target sector';

  return normalizeSchema({
    title: `${title} Application Draft`,
    subtitle: 'AI-inferred application structure. Capture the live external form with the extension for the most accurate field list.',
    sections: [
      {
        title: 'Startup Basics',
        fields: [
          { id: 'startup_name', label: 'Startup name', type: 'text', required: true },
          { id: 'website', label: 'Website', type: 'url', required: false },
          { id: 'contact_email', label: 'Application email', type: 'email', required: true },
          { id: 'location', label: 'Location', type: 'text', required: true }
        ]
      },
      {
        title: 'Opportunity Fit',
        fields: [
          { id: 'startup_overview', label: 'Startup overview', type: 'textarea', required: true, help_text: `Explain what you are building in ${sectorPrompt}.` },
          { id: 'problem_statement', label: 'Problem statement', type: 'textarea', required: true },
          { id: 'solution_summary', label: 'Solution summary', type: 'textarea', required: true },
          { id: 'why_this_opportunity', label: 'Why are you a strong fit for this opportunity?', type: 'textarea', required: true }
        ]
      },
      {
        title: 'Execution and Impact',
        fields: [
          { id: 'traction_metrics', label: 'Traction or proof points', type: 'textarea', required: true },
          { id: 'team_background', label: 'Team background', type: 'textarea', required: true },
          { id: 'use_of_funds', label: 'How will you use the funding or support?', type: 'textarea', required: true },
          { id: 'milestones', label: 'Upcoming milestones', type: 'textarea', required: true }
        ]
      }
    ],
    required_documents: ['Pitch deck', 'Financial projections']
  }, `${title} Application Draft`);
}

module.exports = {
  normalizeSchema,
  flattenSchema,
  buildInitialFormFields,
  calculateCompletion,
  inferSchemaFromOpportunity
};
