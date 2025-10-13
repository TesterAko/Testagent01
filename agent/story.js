// agent/story.js
// Modus 2: Vorgaben des Users gezielt testen
import { executeActions } from '../browser/action-executor.js';
import { parseGptActionSuggestions } from '../utils/parseGptSuggestions.js';

export async function runUserStory({ page, llm, story, contextSummary = '' }) {
    console.log('📖 Starte User-Story Test…');

    // Falls du reine Steps übergibst, kannst du sie direkt parsen/ausführen.
    // Andernfalls generieren wir aus der Story knappe UI-Schritte.
    let planText = '';
    if (llm?.getUserStoryPlan) {
        planText = await llm.getUserStoryPlan(story || contextSummary || 'Execute acceptance criteria.');
    } else {
        planText = `- Click on wkrad-id="Main.Nav.Orders"
- Click on wkrad-id="Orders.Create.Button"
- Fill wkrad-id="Order.Customer.Input" with "ACME GmbH"
- Select wkrad-id="Order.Type.Select" option "Express"
- Click on wkrad-id="Order.Save.Button"`;
    }

    console.log('📝 Plan (roh):\n' + planText);
    const actions = parseGptActionSuggestions(planText);
    console.log('🧪 Geparste Steps: ', actions.length);
    await executeActions(page, actions, 'story');

    console.log('✅ User-Story Test beendet.');
}
