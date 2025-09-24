const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const Activity = require('../models/Activity');
const oidcAuth = require('../middleware/oidc-auth');
const { getClientIp } = require('../utils/ip-helper');

const router = express.Router();

// Helper function to add user context to render data
function addUserContext(req, renderData) {
  return {
    ...renderData,
    isUserInterface: true,
    currentUser: req.oidc_user
  };
}

// User dashboard
router.get('/', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  console.log('🎯 USER ROUTE: Root path hit - rendering user dashboard');
  console.log('🎯 USER ROUTE: User roles:', req.oidc_user?.roles);
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    // Get user's active sessions
    const allSessions = await Session.findByUserId(user._id);
    const activeSessions = allSessions.filter(session => session.active && !session.isExpired());

    // Get recent activity for this user
    const recentActivity = await Activity.findByUserId(user._id, 10);

    const stats = {
      totalSessions: allSessions.length,
      activeSessions: activeSessions.length,
      lastLogin: activeSessions.length > 0 ? Math.max(...activeSessions.map(s => new Date(s.created_at).getTime())) : null
    };

    res.render('user-dashboard', addUserContext(req, {
      title: 'My Account',
      isDashboard: true,
      user: user.toPublicJSON(),
      stats,
      recentActivity: recentActivity.map(activity => activity.toPublicJSON()),
      activeSessions: activeSessions.slice(0, 5).map(session => session.toPublicJSON())
    }));
  } catch (error) {
    console.error('User dashboard error:', error);
    res.render('error', addUserContext(req, {
      title: 'Dashboard Error',
      message: 'Unable to load your dashboard. Please try again later.'
    }));
  }
});

// User profile view
router.get('/profile', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    res.render('user-profile', addUserContext(req, {
      title: 'My Profile',
      isProfile: true,
      user: user.toPublicJSON()
    }));
  } catch (error) {
    console.error('User profile error:', error);
    res.render('error', addUserContext(req, {
      title: 'Profile Error',
      message: 'Unable to load your profile. Please try again later.'
    }));
  }
});

// Update user profile
router.post('/profile', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    const { firstName, lastName } = req.body;

    // Users can only update their names
    user.first_name = firstName || undefined;
    user.last_name = lastName || undefined;

    await user.save();

    // Log activity
    await Activity.logActivity('profile_updated', {
      target_username: user.username,
      target_user_id: user._id,
      username: user.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent']
    });

    res.redirect('/profile?message=Profile updated successfully&messageType=success');
  } catch (error) {
    console.error('Update profile error:', error);
    const user = await User.findByUsername(req.oidc_user.username);
    res.render('user-profile', addUserContext(req, {
      title: 'My Profile',
      isProfile: true,
      user: user ? user.toPublicJSON() : {},
      message: 'Error updating profile: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// Change password form
router.get('/change-password', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    res.render('user-change-password', addUserContext(req, {
      title: 'Change Password',
      isChangePassword: true
    }));
  } catch (error) {
    console.error('Change password form error:', error);
    res.render('error', addUserContext(req, {
      title: 'Error',
      message: 'Unable to load password change form. Please try again later.'
    }));
  }
});

// Process password change
router.post('/change-password', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.render('user-change-password', addUserContext(req, {
        title: 'Change Password',
        isChangePassword: true,
        message: 'All fields are required',
        messageType: 'danger'
      }));
    }

    if (newPassword !== confirmPassword) {
      return res.render('user-change-password', addUserContext(req, {
        title: 'Change Password',
        isChangePassword: true,
        message: 'New passwords do not match',
        messageType: 'danger'
      }));
    }

    if (newPassword.length < 8) {
      return res.render('user-change-password', addUserContext(req, {
        title: 'Change Password',
        isChangePassword: true,
        message: 'New password must be at least 8 characters long',
        messageType: 'danger'
      }));
    }

    // Verify current password
    const isCurrentPasswordValid = await user.verifyPassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.render('user-change-password', addUserContext(req, {
        title: 'Change Password',
        isChangePassword: true,
        message: 'Current password is incorrect',
        messageType: 'danger'
      }));
    }

    // Update password
    user.passwordHash = await User.hashPassword(newPassword);
    await user.save();

    // Log activity
    await Activity.logActivity('password_changed', {
      target_username: user.username,
      target_user_id: user._id,
      username: user.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent']
    });

    res.redirect('/?message=Password changed successfully&messageType=success');
  } catch (error) {
    console.error('Change password error:', error);
    res.render('user-change-password', addUserContext(req, {
      title: 'Change Password',
      isChangePassword: true,
      message: 'Error changing password: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// User sessions management
router.get('/sessions', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).render('error', addUserContext(req, {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      }));
    }

    const allSessions = await Session.findByUserId(user._id);
    const currentSessionId = req.sessionID;

    const sessionsWithStatus = allSessions.map(session => {
      const sessionData = session.toPublicJSON();
      sessionData.isExpired = session.isExpired();
      sessionData.isCurrent = sessionData.id === currentSessionId;
      return sessionData;
    });

    const stats = {
      totalSessions: allSessions.length,
      activeSessions: sessionsWithStatus.filter(s => s.active && !s.isExpired).length,
      expiredSessions: sessionsWithStatus.filter(s => s.active && s.isExpired).length,
      inactiveSessions: sessionsWithStatus.filter(s => !s.active).length
    };

    res.render('user-sessions', addUserContext(req, {
      title: 'My Sessions',
      isSessions: true,
      sessions: sessionsWithStatus,
      stats
    }));
  } catch (error) {
    console.error('User sessions error:', error);
    res.render('error', addUserContext(req, {
      title: 'Sessions Error',
      message: 'Unable to load your sessions. Please try again later.'
    }));
  }
});

// Revoke session
router.post('/sessions/:id/revoke', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sessionId = decodeURIComponent(req.params.id);
    const session = await Session.findById(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Ensure user can only revoke their own sessions
    if (session.user_id !== user._id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Don't allow revoking current session
    if (sessionId === req.sessionID) {
      return res.status(400).json({ error: 'Cannot revoke current session' });
    }

    // Revoke session
    session.active = false;
    await session.save();

    // Log activity
    await Activity.logActivity('session_revoked', {
      target_username: user.username,
      target_user_id: user._id,
      username: user.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent'],
      details: { sessionId: sessionId }
    });

    res.json({ success: true, message: 'Session revoked successfully' });
  } catch (error) {
    console.error('Revoke session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke all sessions except current
router.post('/sessions/revoke-all', oidcAuth.requireOidcAuth('user'), async (req, res) => {
  try {
    const user = await User.findByUsername(req.oidc_user.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const allSessions = await Session.findByUserId(user._id);
    const currentSessionId = req.sessionID;

    let revokedCount = 0;
    for (const session of allSessions) {
      if (session._id !== currentSessionId && session.active) {
        session.active = false;
        await session.save();
        revokedCount++;
      }
    }

    // Log activity
    await Activity.logActivity('all_sessions_revoked', {
      target_username: user.username,
      target_user_id: user._id,
      username: user.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent'],
      details: { revokedCount }
    });

    res.json({ success: true, message: `${revokedCount} sessions revoked successfully` });
  } catch (error) {
    console.error('Revoke all sessions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;